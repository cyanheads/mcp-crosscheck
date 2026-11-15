/**
 * @file tests/e2e/hermetic.test.ts
 * Hermetic core lane: the programmatic API against the bundled fixture server
 * over stdio and streamable-http — ground truth, target launch, pagination,
 * canary, SDK v1 rejects, and orchestration with stand-in clients. No network and
 * no binaries beyond bun. Run: `bun test tests/e2e/hermetic.test.ts`. Shared
 * constants and the lane overview live in `tests/e2e/harness.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  captureGroundTruth,
  runGroundTruthCanary,
  terminateGroundTruthSession,
} from '../../src/ground-truth.js';
import { compareSurface } from '../../src/invariants.js';
import { renderHumanReport, toJsonReport } from '../../src/report.js';
import {
  type CrosscheckOptions,
  CrosscheckUsageError,
  MAX_TIMEOUT_MS,
  runCrosscheck,
} from '../../src/run.js';
import { renderedPropertiesFromJsonSchema, renderedToolFromJsonSchema } from '../../src/schema.js';
import type {
  AdapterName,
  CanarySpec,
  GroundTruth,
  RenderedSurface,
  RunReport,
  TargetSpec,
} from '../../src/types.js';
import { type Exec, spawnManaged } from '../../src/util/exec.js';
import { getFreePort, waitForReady } from '../../src/util/net.js';
import { VERSION } from '../../src/version.js';
import { FIXTURE_TOOLS } from '../fixture-server/tools.js';
import {
  CANARY,
  canonicalEnvNames,
  FIXTURE_SERVER,
  INSPECTOR_PIN,
  launchProbes,
  NESTED_CANARY,
  REPO_ROOT,
  TIMEOUT_MS,
  UNREACHABLE_URL,
} from './harness.js';

/** Under `bun test` the launcher runs from source, beside the module that resolves it. */
const LAUNCHER = join(REPO_ROOT, 'src', 'launch-target.ts');
const STDIO_TARGET: TargetSpec = {
  args: [FIXTURE_SERVER],
  command: process.execPath,
  env: {},
  kind: 'stdio',
};
const RELATIVE_STDIO_TARGET: TargetSpec = {
  args: ['./tests/fixture-server/server.ts'],
  command: process.execPath,
  env: {},
  kind: 'stdio',
};

/** The captured shape of each fixture tool; `outputSchema` rides along only where advertised. */
const EXPECTED_TOOLS = FIXTURE_TOOLS.map((tool) => ({
  description: tool.description ?? null,
  inputSchema: tool.inputSchema,
  name: tool.name,
  ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
}));

/** The verbatim rendering a faithful client produces — the zero-divergence baseline. */
function verbatimSurface(groundTruth: GroundTruth): RenderedSurface {
  return {
    tools: groundTruth.tools.map((tool) => {
      const rendered = renderedToolFromJsonSchema(tool.name, tool.description, tool.inputSchema);
      if (tool.outputSchema !== undefined) {
        rendered.outputProperties = renderedPropertiesFromJsonSchema(tool.outputSchema);
      }
      return rendered;
    }),
  };
}

/** An Inspector fake rendering the fixture tools, minus some echo properties or otherwise altered. */
function inspectorFixtureExec(
  missingEchoProperties: string[] = [],
  alter: (tools: typeof FIXTURE_TOOLS) => void = () => {},
): Exec {
  const tools = structuredClone(FIXTURE_TOOLS);
  const echo = tools.find((tool) => tool.name === 'echo_message');
  if (echo !== undefined && typeof echo.inputSchema.properties === 'object') {
    for (const name of missingEchoProperties) delete echo.inputSchema.properties?.[name];
  }
  alter(tools);
  return {
    capture: () =>
      Promise.resolve({
        code: 0,
        signal: null,
        stderr: '',
        stdout: JSON.stringify({ tools }),
        timedOut: false,
      }),
    spawn: () => {
      throw new Error('inspector baseline fake does not spawn');
    },
  };
}

/** The stdio fixture with extra environment switches (see tests/fixture-server/server.ts). */
function stdioFixture(env: Record<string, string>): TargetSpec {
  return { args: [FIXTURE_SERVER], command: process.execPath, env, kind: 'stdio' };
}

/** `count` minimal tools named `t0`, `t1`, …, as an `MCP_FIXTURE_TOOLS` value. */
function numberedTools(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      inputSchema: { type: 'object' },
      name: `t${index}`,
    })),
  );
}

/** Start the fixture over streamable HTTP with extra switches. */
async function startHttpFixture(
  env: Record<string, string>,
): Promise<{ stop: () => void; target: Extract<TargetSpec, { kind: 'http' }> }> {
  const port = await getFreePort();
  const proc = spawnManaged(process.execPath, [FIXTURE_SERVER], {
    env: { ...env, MCP_HTTP_PORT: String(port), MCP_TRANSPORT_TYPE: 'http' },
  });
  const failure = await waitForReady({
    failFast: () => (proc.hasExited() ? `fixture server exited — ${proc.stderrTail()}` : null),
    intervalMs: 50,
    probe: () => Promise.resolve(proc.stderrTail().includes('streamable-http on')),
    timeoutMs: TIMEOUT_MS,
  });
  if (failure !== null) {
    proc.kill();
    throw new Error(failure);
  }
  return {
    stop: () => proc.kill(),
    target: { kind: 'http', url: `http://127.0.0.1:${port}/mcp` },
  };
}

/** The JSON-RPC requests an HTTP fixture recorded, in arrival order. */
async function recordedCalls(path: string): Promise<{ cursor?: string; rpcMethod: string }[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { cursor?: string; rpcMethod: string | null })
    .filter((record): record is { cursor?: string; rpcMethod: string } =>
      ['tools/call', 'tools/list'].includes(record.rpcMethod ?? ''),
    )
    .map(({ cursor, rpcMethod }) => (cursor === undefined ? { rpcMethod } : { cursor, rpcMethod }));
}

/** The test process's own environment, as a client would pass all of it on. */
function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * An Inspector stand-in that starts the stdio command line it is handed the way
 * a client does: from the cwd the adapter gives it, with its own whole
 * environment plus any `-e K=V` flags, through the SDK client. It answers
 * `tools/list` and `tools/call` with what the server returned.
 */
function launchingInspectorExec(clientEnv: Record<string, string>): Exec {
  return {
    capture: async (_command, args, opts) => {
      const env = { ...clientEnv };
      let index = args.indexOf('--cli') + 1;
      while (args[index] === '-e') {
        const [name = '', ...value] = (args[index + 1] ?? '').split('=');
        env[name] = value.join('=');
        index += 2;
      }
      const method = args.indexOf('--method');
      const [command = '', ...commandArgs] = args.slice(index, method);
      const client = new Client({ name: 'inspector-stand-in', version: '0.0.0' });
      await client.connect(
        new StdioClientTransport({
          args: commandArgs,
          command,
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          env,
          stderr: 'ignore',
        }),
      );
      try {
        const result =
          args[method + 1] === 'tools/list'
            ? await client.listTools()
            : await client.callTool({
                arguments: JSON.parse(args[args.indexOf('--tool-args-json') + 1] ?? '{}'),
                name: args[args.indexOf('--tool-name') + 1] ?? '',
              });
        return {
          code: 0,
          signal: null,
          stderr: '',
          stdout: JSON.stringify(result),
          timedOut: false,
        };
      } finally {
        await client.close();
      }
    },
    spawn: () => {
      throw new Error('the Inspector stand-in does not spawn');
    },
  };
}

describe('hermetic core: stdio', () => {
  let groundTruth: GroundTruth;

  beforeAll(async () => {
    groundTruth = await captureGroundTruth(STDIO_TARGET, TIMEOUT_MS);
  });

  test('captures the fixture schemas verbatim', () => {
    expect(groundTruth.serverName).toBe('crosscheck-fixture-server');
    expect(groundTruth.serverVersion).toBe('1.0.0');
    expect(groundTruth.tools).toEqual(EXPECTED_TOOLS);
    expect(groundTruth.truncation).toBeNull();
  });

  test('a client that renders ground truth verbatim diverges nowhere', () => {
    expect(compareSurface(groundTruth.tools, verbatimSurface(groundTruth))).toEqual([]);
  });

  test('no_args stays clean even when rendered with no request body', () => {
    const noArgs = groundTruth.tools.find((tool) => tool.name === 'no_args');
    expect(noArgs).toBeDefined();
    const stripped = {
      tools: [renderedToolFromJsonSchema('no_args', noArgs?.description ?? null, {})],
    };
    expect(compareSurface([noArgs!], stripped)).toEqual([]);
  });

  test('the canary round-trips through the SDK client', async () => {
    expect(await runGroundTruthCanary(STDIO_TARGET, CANARY, TIMEOUT_MS)).toEqual({
      attempted: true,
      detail: null,
      ok: true,
    });
  });

  test('a tool advertising an output schema answers with validating structured content', async () => {
    // The negative cases live under "hermetic core: ground-truth canary".
    expect(await runGroundTruthCanary(STDIO_TARGET, NESTED_CANARY, TIMEOUT_MS)).toEqual({
      attempted: true,
      detail: null,
      ok: true,
    });
  });

  test('a canary the fixture rejects reports the failure rather than throwing', async () => {
    const outcome = await runGroundTruthCanary(
      STDIO_TARGET,
      { args: {}, tool: 'not_a_tool' },
      TIMEOUT_MS,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('not_a_tool');
  });
});

describe('hermetic core: target launch', () => {
  test('ground truth, its canary, and a client starting the command line it was handed launch the target identically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-launch-parity-'));
    const probePath = join(dir, 'probe.jsonl');
    const env = { CROSSCHECK_PASSED: 'from --env', MCP_FIXTURE_PROBE_PATH: probePath };
    try {
      const report = await runCrosscheck({
        adapters: ['inspector'],
        canary: CANARY,
        // The stand-in passes its whole environment on, plus a variable only it has.
        exec: launchingInspectorExec({ ...processEnv(), CROSSCHECK_CLIENT_ONLY: 'client' }),
        pins: { inspector: INSPECTOR_PIN },
        target: {
          args: [FIXTURE_SERVER, '--flag', 'x', '-e', 'y'],
          command: process.execPath,
          env,
          kind: 'stdio',
        },
        timeoutMs: TIMEOUT_MS,
      });
      expect([report.adapters[0]?.status, report.adapters[0]?.canary?.ok]).toEqual(['ok', true]);
      expect(report.adapters[0]?.findings).toEqual([]);

      // Ground truth, the ground-truth canary, the client's tools/list, and its canary.
      const probes = await launchProbes(probePath);
      expect(probes).toEqual(
        Array.from({ length: 4 }, () => ({
          argv: ['--flag', 'x', '-e', 'y'],
          cwd: process.cwd(),
          envNames: canonicalEnvNames(env),
          home: process.env.HOME ?? null,
        })),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('hands each client a launcher command line whose spec is private to the run', async () => {
    const secret = 'env-value-never-on-a-command-line';
    const target: TargetSpec = {
      args: [FIXTURE_SERVER, '--flag', 'x'],
      command: process.execPath,
      env: { CROSSCHECK_SECRET: secret },
      kind: 'stdio',
    };
    const seen: {
      args: string[];
      cwd: string | undefined;
      spec: { content: unknown; dir: string; mode: number; path: string } | null;
    }[] = [];
    const exec: Exec = {
      capture: async (_command, args, opts) => {
        const specPath = args[args.indexOf('--cli') + 3] ?? '';
        seen.push({
          args,
          cwd: opts.cwd,
          spec: specPath.endsWith('.json')
            ? {
                content: JSON.parse(await readFile(specPath, 'utf8')),
                dir: dirname(specPath),
                mode: (await stat(specPath)).mode & 0o777,
                path: specPath,
              }
            : null,
        });
        return {
          code: 0,
          signal: null,
          stderr: '',
          stdout: JSON.stringify({ tools: FIXTURE_TOOLS }),
          timedOut: false,
        };
      },
      spawn: () => {
        throw new Error('the launch fake does not spawn');
      },
    };
    const report = await runCrosscheck({
      adapters: ['inspector'],
      exec,
      pins: { inspector: INSPECTOR_PIN },
      target,
      timeoutMs: TIMEOUT_MS,
    });
    expect(report.adapters[0]?.status).toBe('ok');
    // The report names the target as given, not the launcher that ran it.
    expect(report.target).toEqual({ args: target.args, command: target.command, kind: 'stdio' });

    expect(seen).toHaveLength(1);
    const [call] = seen;
    const cli = call?.args.indexOf('--cli') ?? -1;
    const specPath = call?.spec?.path ?? 'no spec on the command line';
    expect(call?.args.slice(cli + 1)).toEqual([
      process.execPath,
      LAUNCHER,
      specPath,
      '--method',
      'tools/list',
    ]);
    expect(call?.spec).toMatchObject({
      content: {
        args: target.args,
        command: target.command,
        cwd: process.cwd(),
        env: { ...getDefaultEnvironment(), CROSSCHECK_SECRET: secret },
      },
      dir: call?.cwd,
      mode: 0o600,
    });
    expect(JSON.stringify(seen.map((entry) => entry.args))).not.toContain(secret);
    // The spec and the scratch directory holding it are gone with the run.
    await expect(stat(specPath)).rejects.toThrow('ENOENT');
    await expect(stat(call?.cwd ?? '')).rejects.toThrow('ENOENT');
  });

  // A directory whose removal fails, as a client tree still dying in it makes it fail on Windows.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a scratch directory that cannot be removed still loses the launch spec, and the log names it',
    async () => {
      let workDir = '';
      const exec: Exec = {
        capture: async (_command, _args, opts) => {
          workDir = opts.cwd ?? '';
          await mkdir(join(workDir, 'held'));
          await writeFile(join(workDir, 'held', 'file'), '');
          await chmod(join(workDir, 'held'), 0o500);
          return {
            code: 0,
            signal: null,
            stderr: '',
            stdout: JSON.stringify({ tools: FIXTURE_TOOLS }),
            timedOut: false,
          };
        },
        spawn: () => {
          throw new Error('the cleanup fake does not spawn');
        },
      };
      const lines: string[] = [];
      try {
        const report = await runCrosscheck({
          adapters: ['inspector'],
          exec,
          log: (line) => lines.push(line),
          pins: { inspector: INSPECTOR_PIN },
          target: { ...STDIO_TARGET, env: { CROSSCHECK_SECRET: 'held-run' } },
          timeoutMs: TIMEOUT_MS,
        });
        expect(report.adapters[0]?.status).toBe('ok');
        await expect(stat(join(workDir, 'target-launch.json'))).rejects.toThrow('ENOENT');
        const named = lines.filter((line) => line.includes(workDir));
        expect(named).toHaveLength(1);
        expect(named[0]).toStartWith(`could not remove the scratch directory ${workDir}: `);
      } finally {
        await chmod(join(workDir, 'held'), 0o700);
        await rm(workDir, { force: true, recursive: true });
      }
    },
  );

  test('a bare relative target path runs from the caller directory', async () => {
    const report = await runCrosscheck({
      adapters: [],
      canary: CANARY,
      target: {
        args: ['tests/fixture-server/server.ts'],
        command: process.execPath,
        env: {},
        kind: 'stdio',
      },
      timeoutMs: TIMEOUT_MS,
    });
    expect([report.pass, report.groundTruth.toolCount, report.groundTruth.canary?.ok]).toEqual([
      true,
      6,
      true,
    ]);
  });

  test('a target that exits at startup reports what it wrote to stderr', async () => {
    const fatal = 'fatal: FOO_API_KEY is not set; refusing to start';
    const target = stdioFixture({ MCP_FIXTURE_FATAL: fatal });
    await expect(captureGroundTruth(target, TIMEOUT_MS)).rejects.toThrow(fatal);
    expect((await runGroundTruthCanary(target, CANARY, TIMEOUT_MS)).detail).toContain(fatal);
    const run = runCrosscheck({ adapters: [], target, timeoutMs: TIMEOUT_MS });
    await expect(run).rejects.toThrow(fatal);
    await expect(run).rejects.not.toBeInstanceOf(CrosscheckUsageError);
  });

  test('a target that floods stderr past the pipe buffer keeps serving, and a failure carries only the tail', async () => {
    // Far past every buffer between the server's blocking write and the drain.
    const flood = String(4 * 1024 * 1024);
    const served = await captureGroundTruth(
      stdioFixture({ MCP_FIXTURE_STDERR_BYTES: flood }),
      TIMEOUT_MS,
    );
    expect(served.tools).toEqual(EXPECTED_TOOLS);

    const fatal = 'error: the configuration file is unreadable';
    const failure = await captureGroundTruth(
      stdioFixture({ MCP_FIXTURE_FATAL: fatal, MCP_FIXTURE_STDERR_BYTES: flood }),
      TIMEOUT_MS,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(fatal);
    expect((failure as Error).message.length).toBeLessThan(1_000);
  });

  test('a request a live target fails carries none of its stderr', async () => {
    const outcome = await runGroundTruthCanary(
      stdioFixture({ MCP_FIXTURE_INVALID_OUTPUT: 'mismatch', MCP_FIXTURE_STDERR_BYTES: '64' }),
      NESTED_CANARY,
      TIMEOUT_MS,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("Structured content does not match the tool's output schema");
    expect(outcome.detail).not.toContain('x'.repeat(32));
  });

  test('a target command that cannot start fails ground truth with the spawn error', async () => {
    const missing = join(tmpdir(), 'crosscheck-no-such-command');
    await expect(
      captureGroundTruth({ args: [], command: missing, env: {}, kind: 'stdio' }, TIMEOUT_MS),
    ).rejects.toThrow('ENOENT');
  });
});

describe('hermetic core: streamable-http', () => {
  let target: TargetSpec;
  let stop: () => void;

  beforeAll(async () => {
    const port = await getFreePort();
    const proc = spawnManaged(process.execPath, [FIXTURE_SERVER], {
      env: { MCP_HTTP_PORT: String(port), MCP_TRANSPORT_TYPE: 'http' },
    });
    stop = () => proc.kill();
    const failure = await waitForReady({
      failFast: () => (proc.hasExited() ? `fixture server exited — ${proc.stderrTail()}` : null),
      intervalMs: 50,
      probe: () => Promise.resolve(proc.stderrTail().includes('streamable-http on')),
      timeoutMs: TIMEOUT_MS,
    });
    if (failure !== null) throw new Error(failure);
    target = { kind: 'http', url: `http://127.0.0.1:${port}/mcp` };
  });

  afterAll(() => stop());

  test('captures the fixture schemas verbatim, same as stdio', async () => {
    const groundTruth = await captureGroundTruth(target, TIMEOUT_MS);
    expect(groundTruth.serverName).toBe('crosscheck-fixture-server');
    expect(groundTruth.tools).toEqual(EXPECTED_TOOLS);
  });

  test('the canary round-trips over http', async () => {
    expect(await runGroundTruthCanary(target, CANARY, TIMEOUT_MS)).toEqual({
      attempted: true,
      detail: null,
      ok: true,
    });
  });

  test('a tool advertising an output schema answers with validating structured content over http', async () => {
    expect(await runGroundTruthCanary(target, NESTED_CANARY, TIMEOUT_MS)).toEqual({
      attempted: true,
      detail: null,
      ok: true,
    });
  });

  test('redacts server-controlled identity from every progress log line', async () => {
    const secret = 'crosscheck-fixture-server';
    const logs: string[] = [];
    const httpTarget = target as Extract<TargetSpec, { kind: 'http' }>;
    await runCrosscheck({
      adapters: [],
      log: (line) => logs.push(line),
      target: { ...httpTarget, headers: { 'X-Dummy': secret } },
      timeoutMs: TIMEOUT_MS,
    });
    expect(logs.join('\n')).not.toContain(secret);
    expect(logs.join('\n')).toContain('[REDACTED]');
  });

  test('redaction rewrites free text only: rule ids, evidence, paths, names, and versions keep their values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-redaction-'));
    const baselinePath = join(dir, 'baseline.json');
    const httpTarget = target as Extract<TargetSpec, { kind: 'http' }>;
    // Short, non-secret values that occur inside a rule id, a tool name, and version strings.
    const options: CrosscheckOptions = {
      adapters: ['inspector'],
      exec: inspectorFixtureExec([], (tools) => {
        const message = tools.find((tool) => tool.name === 'echo_message')?.inputSchema.properties
          ?.message;
        if (message === undefined) throw new Error('fixture lost echo_message.message');
        delete (message as Record<string, unknown>).description;
      }),
      pins: { inspector: INSPECTOR_PIN },
      target: { ...httpTarget, headers: { 'X-Feature': 'on', 'X-Level': '1', 'X-Tool': 'echo' } },
      timeoutMs: TIMEOUT_MS,
    };
    try {
      const read = await runCrosscheck(options);
      for (const report of [read, JSON.parse(toJsonReport(read)) as RunReport]) {
        expect(report.adapters[0]?.newFindings).toEqual([
          {
            detail: 'property descripti[REDACTED] was lost in rendering',
            evidence: { kind: 'description-lost', subject: 'property' },
            path: 'echo_message.message',
            rule: 'description-lost',
            severity: 'fail',
          },
        ]);
        expect(report.crosscheckVersion).toBe(VERSION);
        expect(report.adapters[0]?.resolvedVersion).toBe(INSPECTOR_PIN);
        expect(report.groundTruth.serverVersion).toBe('1.0.0');
        expect(report.groundTruth.toolNames).toContain('echo_message');
        expect(report.target).toEqual({ kind: 'http', url: httpTarget.url });
      }
      expect(renderHumanReport(read)).toContain('[description-lost] echo_message.message');

      const updated = await runCrosscheck({ ...options, baselinePath, updateBaseline: true });
      expect(updated.acknowledgedCount).toBe(1);
      expect(JSON.parse(await readFile(baselinePath, 'utf8')).entries).toEqual([
        {
          adapter: 'inspector',
          evidence: { kind: 'description-lost', subject: 'property' },
          path: 'echo_message.message',
          rule: 'description-lost',
        },
      ]);

      // The written entries carry no header value, so they acknowledge a run under another one.
      const other = await runCrosscheck({
        ...options,
        baselinePath,
        target: { ...httpTarget, headers: { 'X-Feature': 'off' } },
      });
      expect(other.pass).toBe(true);
      expect(other.acknowledgedCount).toBe(1);
      expect(other.staleCount).toBe(0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe('hermetic core: protected streamable-http', () => {
  test('carries the configured header through initialize, tools/list, tools/call, and DELETE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-protected-http-'));
    const recordPath = join(dir, 'requests.jsonl');
    const port = await getFreePort();
    const secret = 'fixture:secret';
    const proc = spawnManaged(process.execPath, [FIXTURE_SERVER], {
      env: {
        MCP_HTTP_PORT: String(port),
        MCP_HTTP_RECORD_PATH: recordPath,
        MCP_REQUIRED_HEADER_NAME: 'X-Fixture-Auth',
        MCP_REQUIRED_HEADER_VALUE: secret,
        MCP_TRANSPORT_TYPE: 'http',
      },
    });
    const target: Extract<TargetSpec, { kind: 'http' }> = {
      headers: { 'X-Fixture-Auth': `  ${secret}  `.trim() },
      kind: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
    };
    try {
      const failure = await waitForReady({
        failFast: () => (proc.hasExited() ? `fixture server exited — ${proc.stderrTail()}` : null),
        intervalMs: 50,
        probe: () => Promise.resolve(proc.stderrTail().includes('streamable-http on')),
        timeoutMs: TIMEOUT_MS,
      });
      if (failure !== null) throw new Error(failure);
      expect((await captureGroundTruth(target, TIMEOUT_MS)).tools).toHaveLength(6);
      expect(await runGroundTruthCanary(target, CANARY, TIMEOUT_MS)).toEqual({
        attempted: true,
        detail: null,
        ok: true,
      });
      await terminateGroundTruthSession(target, TIMEOUT_MS);

      const records = (await readFile(recordPath, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as { header: string; method: string; rpcMethod: string | null },
        );
      expect(records.every((record) => record.header === secret)).toBe(true);
      expect(records.map((record) => record.rpcMethod)).toContain('initialize');
      expect(records.map((record) => record.rpcMethod)).toContain('tools/list');
      expect(records.map((record) => record.rpcMethod)).toContain('tools/call');
      expect(records.map((record) => record.method)).toContain('DELETE');

      const report = await runCrosscheck({ adapters: [], target, timeoutMs: TIMEOUT_MS });
      expect(report.target).toEqual({ kind: 'http', url: target.url });
      expect(toJsonReport(report)).not.toContain(secret);
    } finally {
      proc.kill();
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('redacts a controlled rejected response from fatal diagnostics', async () => {
    const port = await getFreePort();
    const secret = 'fixture-secret';
    const proc = spawnManaged(process.execPath, [FIXTURE_SERVER], {
      env: {
        MCP_HTTP_PORT: String(port),
        MCP_REJECT_HEADER: '1',
        MCP_REQUIRED_HEADER_NAME: 'X-Fixture-Auth',
        MCP_REQUIRED_HEADER_VALUE: secret,
        MCP_TRANSPORT_TYPE: 'http',
      },
    });
    try {
      const failure = await waitForReady({
        failFast: () => (proc.hasExited() ? `fixture server exited — ${proc.stderrTail()}` : null),
        intervalMs: 50,
        probe: () => Promise.resolve(proc.stderrTail().includes('streamable-http on')),
        timeoutMs: TIMEOUT_MS,
      });
      if (failure !== null) throw new Error(failure);
      await expect(
        runCrosscheck({
          adapters: [],
          target: {
            headers: { 'X-Fixture-Auth': secret },
            kind: 'http',
            url: `http://127.0.0.1:${port}/mcp`,
          },
          timeoutMs: TIMEOUT_MS,
        }),
      ).rejects.not.toThrow(secret);
    } finally {
      proc.kill();
    }
  });

  /**
   * Header values a failing canary's text echoes: one straddling the 400-character
   * excerpt cut, one holding a tab and repeated spaces that the excerpt collapses.
   */
  const ECHOED_HEADER_VALUES = [
    {
      text: (value: string) => `${'x'.repeat(390)} ${value} tail`,
      value: 'zq7-straddle-9f8e7d6c5b4a',
    },
    {
      text: (value: string) => `error: upstream rejected Authorization ${value}`,
      value: 'Bearer\tzq7  tabbed',
    },
  ];

  /** Neither the value, a prefix of it, nor its whitespace-collapsed form survived. */
  function expectRedacted(text: string | null | undefined, value: string): void {
    expect(text).toMatch(/\[REDACTE/);
    expect(text).not.toContain(value.slice(0, 5));
    expect(text).not.toContain(value.replace(/\s+/g, ' '));
  }

  test('a canary failure is redacted before it is excerpted', async () => {
    for (const { text, value } of ECHOED_HEADER_VALUES) {
      const { stop, target } = await startHttpFixture({ MCP_FIXTURE_CALL_ERROR: text(value) });
      try {
        const protectedTarget = { ...target, headers: { 'X-Token': value } };
        const outcome = await runGroundTruthCanary(protectedTarget, CANARY, TIMEOUT_MS);
        expect(outcome.ok).toBe(false);
        expectRedacted(outcome.detail, value);

        const error = await runCrosscheck({
          adapters: [],
          canary: CANARY,
          target: protectedTarget,
          timeoutMs: TIMEOUT_MS,
        }).then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(CrosscheckUsageError);
        expect((error as Error).message).toContain('before any adapter ran');
        expectRedacted((error as Error).message, value);
      } finally {
        stop();
      }
    }
  });
});

describe('hermetic core: tools/list pagination', () => {
  const REPEATING = stdioFixture({ MCP_FIXTURE_CURSOR: 'repeat', MCP_FIXTURE_PAGE_SIZE: '1' });
  const REPEATED_NOTE = 'tools/list stopped after 2 page(s): the server repeated a cursor';

  test('a multi-page list that ends without a nextCursor is complete and passes', async () => {
    const target = stdioFixture({ MCP_FIXTURE_PAGE_SIZE: '1' });
    const groundTruth = await captureGroundTruth(target, TIMEOUT_MS);
    expect(groundTruth.tools).toEqual(EXPECTED_TOOLS);
    expect(groundTruth.truncation).toBeNull();
    const report = await runCrosscheck({ adapters: [], target, timeoutMs: TIMEOUT_MS });
    expect([report.pass, report.groundTruth.toolCount, report.groundTruth.truncation]).toEqual([
      true,
      6,
      null,
    ]);
  });

  test('exactly the page cap of pages, the last without a nextCursor, is complete', async () => {
    const groundTruth = await captureGroundTruth(
      stdioFixture({ MCP_FIXTURE_PAGE_SIZE: '1', MCP_FIXTURE_TOOLS: numberedTools(100) }),
      TIMEOUT_MS,
    );
    expect(groundTruth.tools).toHaveLength(100);
    expect(groundTruth.truncation).toBeNull();
  });

  test('a repeated cursor stops the walk with that page kept, and the run fails with no findings', async () => {
    const logs: string[] = [];
    const report = await runCrosscheck({
      adapters: [],
      log: (line) => logs.push(line),
      target: REPEATING,
      timeoutMs: TIMEOUT_MS,
    });
    expect(report.groundTruth.toolNames).toEqual(['echo_message', 'union_modes']);
    expect(report.groundTruth.truncation).toEqual({ pagesRead: 2, reason: 'cursor-repeated' });
    expect([report.pass, report.failCount]).toEqual([false, 0]);
    expect((JSON.parse(toJsonReport(report)) as RunReport).groundTruth.truncation).toEqual({
      pagesRead: 2,
      reason: 'cursor-repeated',
    });
    expect(logs.find((line) => line.startsWith('ground truth:'))).toContain(REPEATED_NOTE);
    const lines = renderHumanReport(report).split('\n');
    expect(lines[0]).toContain(REPEATED_NOTE);
    expect(lines.at(-1)).toStartWith('FAIL');
    expect(lines.at(-1)).toContain(REPEATED_NOTE);
  });

  test('a cycling cursor stops the walk before any page is requested twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-cycle-'));
    const recordPath = join(dir, 'requests.jsonl');
    const { stop, target } = await startHttpFixture({
      MCP_FIXTURE_CURSOR: 'cycle',
      MCP_FIXTURE_PAGE_SIZE: '1',
      MCP_HTTP_RECORD_PATH: recordPath,
    });
    try {
      const groundTruth = await captureGroundTruth(target, TIMEOUT_MS);
      expect(groundTruth.tools.map((tool) => tool.name)).toEqual([
        'echo_message',
        'union_modes',
        'branch_only_fields',
      ]);
      expect(groundTruth.truncation).toEqual({ pagesRead: 3, reason: 'cursor-repeated' });
      expect(await recordedCalls(recordPath)).toEqual([
        { rpcMethod: 'tools/list' },
        { cursor: 'a', rpcMethod: 'tools/list' },
        { cursor: 'b', rpcMethod: 'tools/list' },
      ]);
    } finally {
      stop();
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('the page cap stops a list that never ends, and the run fails with no findings', async () => {
    const report = await runCrosscheck({
      adapters: [],
      target: stdioFixture({ MCP_FIXTURE_PAGE_SIZE: '1', MCP_FIXTURE_TOOLS: numberedTools(150) }),
      timeoutMs: TIMEOUT_MS,
    });
    expect(report.groundTruth.toolCount).toBe(100);
    expect(report.groundTruth.toolNames.at(-1)).toBe('t99');
    expect(report.groundTruth.truncation).toEqual({ pagesRead: 100, reason: 'page-cap' });
    expect([report.pass, report.failCount]).toEqual([false, 0]);
    expect(renderHumanReport(report)).toContain(
      'tools/list stopped after 100 page(s): the page cap was reached with a nextCursor still in hand',
    );
  });

  test('a truncated run leaves the baseline byte-identical and reports no stale entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-truncated-baseline-'));
    const baselinePath = join(dir, 'baseline.json');
    // Reviewed drift on a tool past the pages read: stale only if the capture were complete.
    const original = `${JSON.stringify(
      {
        baselineVersion: 1,
        entries: [
          {
            adapter: 'inspector',
            evidence: { kind: 'tool-missing' },
            path: 'nested_config',
            rule: 'tool-missing',
          },
        ],
      },
      null,
      2,
    )}\n`;
    await writeFile(baselinePath, original);
    const options: CrosscheckOptions = {
      adapters: ['inspector'],
      baselinePath,
      exec: inspectorFixtureExec(),
      pins: { inspector: INSPECTOR_PIN },
      target: REPEATING,
      timeoutMs: TIMEOUT_MS,
    };
    try {
      for (const updateBaseline of [true, false]) {
        const report = await runCrosscheck({ ...options, updateBaseline });
        expect(report.pass).toBe(false);
        expect(report.adapters[0]?.findings).toEqual([]);
        expect([report.baselineDiagnostics, report.staleCount]).toEqual([[], 0]);
        expect(await readFile(baselinePath, 'utf8')).toBe(original);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('a canary missing from a truncated capture is reported as not found in the pages read', async () => {
    const run = runCrosscheck({
      adapters: [],
      canary: NESTED_CANARY,
      target: REPEATING,
      timeoutMs: TIMEOUT_MS,
    });
    await expect(run).rejects.toThrow(CrosscheckUsageError);
    await expect(run).rejects.toThrow(
      'canary tool "nested_config" was not found in the 2 page(s) of tools/list read before the walk stopped',
    );
  });
});

describe('hermetic core: ground-truth canary', () => {
  const OUTPUT_MISMATCH = "Structured content does not match the tool's output schema";
  const OUTPUT_MISSING = 'has an output schema but did not return structured content';

  test('a structured result that violates the output schema fails the canary with the SDK message', async () => {
    // One page, and one tool per page with nested_config on page 4 of 6.
    for (const pageSize of ['6', '1']) {
      const outcome = await runGroundTruthCanary(
        stdioFixture({ MCP_FIXTURE_INVALID_OUTPUT: 'mismatch', MCP_FIXTURE_PAGE_SIZE: pageSize }),
        NESTED_CANARY,
        TIMEOUT_MS,
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain(OUTPUT_MISMATCH);
    }
  });

  test('a missing structured result fails the canary with the SDK message', async () => {
    const outcome = await runGroundTruthCanary(
      stdioFixture({ MCP_FIXTURE_INVALID_OUTPUT: 'missing', MCP_FIXTURE_PAGE_SIZE: '1' }),
      NESTED_CANARY,
      TIMEOUT_MS,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain(OUTPUT_MISSING);
  });

  test('the canary lists up to the page advertising its tool, then calls before requesting another', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-canary-walk-'));
    const recordPath = join(dir, 'requests.jsonl');
    const { stop, target } = await startHttpFixture({
      MCP_FIXTURE_PAGE_SIZE: '1',
      MCP_HTTP_RECORD_PATH: recordPath,
    });
    try {
      expect(await runGroundTruthCanary(target, NESTED_CANARY, TIMEOUT_MS)).toEqual({
        attempted: true,
        detail: null,
        ok: true,
      });
      expect(await runGroundTruthCanary(target, CANARY, TIMEOUT_MS)).toEqual({
        attempted: true,
        detail: null,
        ok: true,
      });
      expect(await recordedCalls(recordPath)).toEqual([
        { rpcMethod: 'tools/list' },
        { cursor: 'page-1', rpcMethod: 'tools/list' },
        { cursor: 'page-2', rpcMethod: 'tools/list' },
        { cursor: 'page-3', rpcMethod: 'tools/list' },
        { rpcMethod: 'tools/call' },
        { rpcMethod: 'tools/list' },
        { rpcMethod: 'tools/call' },
      ]);
    } finally {
      stop();
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('a canary tool the walk never reaches fails the canary and names the tool', async () => {
    const outcome = await runGroundTruthCanary(
      stdioFixture({ MCP_FIXTURE_CURSOR: 'repeat', MCP_FIXTURE_PAGE_SIZE: '1' }),
      NESTED_CANARY,
      TIMEOUT_MS,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('"nested_config" was not found in 2 page(s) of tools/list');
  });

  test('a failing preflight aborts before any adapter runs, without blaming the canary spec', async () => {
    const run = runCrosscheck({
      adapters: ['inspector'],
      canary: NESTED_CANARY,
      exec: {
        capture: () => Promise.reject(new Error('no adapter may run after a failed preflight')),
        spawn: () => {
          throw new Error('no adapter may run after a failed preflight');
        },
      },
      pins: { inspector: INSPECTOR_PIN },
      target: stdioFixture({ MCP_FIXTURE_INVALID_OUTPUT: 'mismatch' }),
      timeoutMs: TIMEOUT_MS,
    });
    const error = await run.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CrosscheckUsageError);
    expect((error as Error).message).toContain(OUTPUT_MISMATCH);
    expect((error as Error).message).not.toContain('fix the canary spec');
  });
});

describe('hermetic core: tools SDK v1 rejects', () => {
  const OK_TOOL = {
    description: 'Fine.',
    inputSchema: { properties: { a: { type: 'string' } }, type: 'object' },
    name: 'ok_tool',
  };
  const REJECTED = [
    {
      schemaPath: 'inputSchema.properties.payload',
      tool: {
        description: 'Accepts any payload.',
        inputSchema: { properties: { payload: true }, type: 'object' },
        name: 'any_tool',
      },
    },
    {
      schemaPath: 'outputSchema.type',
      tool: {
        description: 'Returns an array.',
        inputSchema: { type: 'object' },
        name: 'arr_out',
        outputSchema: { items: { type: 'string' }, type: 'array' },
      },
    },
  ];

  test('each tool SDK v1 rejects is captured with one info note, and a verbatim rendering diverges nowhere', async () => {
    for (const { schemaPath, tool } of REJECTED) {
      const advertised = [OK_TOOL, tool];
      const report = await runCrosscheck({
        adapters: ['inspector'],
        exec: inspectorFixtureExec([], (tools) => {
          tools.splice(0, tools.length, ...(structuredClone(advertised) as typeof FIXTURE_TOOLS));
        }),
        pins: { inspector: INSPECTOR_PIN },
        target: stdioFixture({ MCP_FIXTURE_TOOLS: JSON.stringify(advertised) }),
        timeoutMs: TIMEOUT_MS,
      });
      expect(report.groundTruth.toolNames).toEqual(['ok_tool', tool.name]);
      expect(
        report.groundTruth.findings.map((finding) => [
          finding.rule,
          finding.severity,
          finding.path,
          finding.evidence,
        ]),
      ).toEqual([['sdk-v1-rejected', 'info', tool.name, { kind: 'sdk-v1-rejected' }]]);
      expect(report.groundTruth.findings[0]?.detail).toContain(schemaPath);
      expect(report.groundTruth.findings[0]?.detail).toContain('@modelcontextprotocol/sdk 1.x');
      expect(report.adapters[0]?.findings).toEqual([]);
      expect([report.pass, report.failCount, report.infoCount]).toEqual([true, 0, 1]);
      expect(renderHumanReport(report)).toContain(`[sdk-v1-rejected] ${tool.name}`);
    }
  });

  test('the canary still works against such a server, and a rejected canary tool is reported rather than thrown', async () => {
    const target = stdioFixture({
      MCP_FIXTURE_TOOLS: JSON.stringify([OK_TOOL, REJECTED[0]?.tool]),
    });
    const okCanary: CanarySpec = { args: { a: 'probe' }, tool: 'ok_tool' };
    expect(await runGroundTruthCanary(target, okCanary, TIMEOUT_MS)).toEqual({
      attempted: true,
      detail: null,
      ok: true,
    });
    const report = await runCrosscheck({
      adapters: [],
      canary: okCanary,
      target,
      timeoutMs: TIMEOUT_MS,
    });
    expect(report.groundTruth.canary?.ok).toBe(true);

    const rejected = await runGroundTruthCanary(target, { args: {}, tool: 'any_tool' }, TIMEOUT_MS);
    expect(rejected.ok).toBe(false);
    expect(rejected.detail).toContain('@modelcontextprotocol/sdk 1.x');
    expect(rejected.detail).toContain('inputSchema.properties.payload');
  });
});

describe('hermetic core: orchestration', () => {
  test('rejects invalid programmatic HTTP header maps without echoing values', async () => {
    const secret = 'programmatic-secret';
    const scenarios = [
      { 'Bad Name': secret },
      { 'X-Empty': '' },
      { 'X-Test': secret, 'x-test': 'duplicate' },
    ];
    for (const headers of scenarios) {
      try {
        await runCrosscheck({
          adapters: ['claude-code'],
          target: { headers, kind: 'http', url: 'http://127.0.0.1:1/mcp' },
        });
        throw new Error('expected programmatic header validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(CrosscheckUsageError);
        expect(String(error)).toContain('header');
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  /**
   * Runs `runCrosscheck` and returns the rejection plus every progress line, so
   * a test can assert a caller mistake surfaced before ground truth was captured.
   */
  async function rejectionOf(
    options: Partial<CrosscheckOptions>,
  ): Promise<{ error: unknown; logs: string[] }> {
    const logs: string[] = [];
    try {
      await runCrosscheck({
        adapters: [],
        target: { headers: {}, kind: 'http', url: UNREACHABLE_URL },
        timeoutMs: 2_000,
        ...options,
        log: (line) => logs.push(line),
      });
    } catch (error) {
      return { error, logs };
    }
    throw new Error('expected runCrosscheck to reject');
  }

  test('rejects unknown and inherited adapter names before ground truth', async () => {
    for (const name of ['nope', 'toString', 'constructor', '__proto__']) {
      const { error, logs } = await rejectionOf({ adapters: [name as AdapterName] });
      expect(error).toBeInstanceOf(CrosscheckUsageError);
      expect(String(error)).toContain(
        `unknown adapter "${name}" — known adapters: inspector, mcpo, codex, claude-code`,
      );
      expect(logs).toEqual([]);
    }
  });

  test('rejects a repeated adapter name before ground truth', async () => {
    const { error, logs } = await rejectionOf({ adapters: ['mcpo', 'inspector', 'mcpo'] });
    expect(error).toBeInstanceOf(CrosscheckUsageError);
    expect(String(error)).toContain('adapter "mcpo" is selected more than once');
    expect(logs).toEqual([]);
  });

  test('rejects pins that name an unknown or inherited adapter before ground truth', async () => {
    const pinSets = [{ nope: '1' }, { constructor: '1' }, JSON.parse('{"__proto__": "1"}')];
    for (const pins of pinSets) {
      const { error, logs } = await rejectionOf({
        pins: pins as Partial<Record<AdapterName, string>>,
      });
      expect(error).toBeInstanceOf(CrosscheckUsageError);
      expect(String(error)).toContain(`pins names unknown adapter "${Object.keys(pins)[0]}"`);
      expect(logs).toEqual([]);
    }
  });

  test('rejects a blank, whitespace-only, or non-string pin before ground truth, naming the adapter', async () => {
    // codex is not selected: a pin is checked whether or not its adapter runs.
    const pinSets = [{ inspector: '' }, { inspector: '   ' }, { inspector: '\t' }, { codex: '' }];
    for (const pins of [...pinSets, { mcpo: 20 as unknown as string }]) {
      const { error, logs } = await rejectionOf({ adapters: ['inspector'], pins });
      expect(error).toBeInstanceOf(CrosscheckUsageError);
      expect(String(error)).toContain(
        `pin for adapter "${Object.keys(pins)[0]}" must be a non-blank version string`,
      );
      expect(logs).toEqual([]);
    }
  });

  test('rejects an unparseable or non-HTTP target URL before ground truth', async () => {
    for (const url of ['notaurl', '/mcp', 'ftp://127.0.0.1:1/mcp', 'file:///tmp/mcp']) {
      const { error, logs } = await rejectionOf({ target: { kind: 'http', url } });
      expect(error).toBeInstanceOf(CrosscheckUsageError);
      expect(String(error)).toContain(`target URL must be an http: or https: URL, got: ${url}`);
      expect(logs).toEqual([]);
    }
  });

  test('redacts a header value echoed by a rejected target URL', async () => {
    const secret = 'url-secret';
    const { error } = await rejectionOf({
      target: { headers: { 'X-Token': secret }, kind: 'http', url: `ftp://${secret}@host/mcp` },
    });
    expect(error).toBeInstanceOf(CrosscheckUsageError);
    expect(String(error)).toContain('ftp://[REDACTED]@host/mcp');
    expect(String(error)).not.toContain(secret);
  });

  test('http: and https: target URLs pass validation and reach ground truth', async () => {
    for (const url of [UNREACHABLE_URL, 'https://127.0.0.1:1/mcp']) {
      const { error, logs } = await rejectionOf({ target: { kind: 'http', url } });
      expect(error).not.toBeInstanceOf(CrosscheckUsageError);
      expect(logs[0]).toContain('capturing ground truth');
    }
  });

  test('rejects a timeoutMs Node timers cannot honor before ground truth', async () => {
    for (const timeoutMs of [0, 0.5, -1, Number.NaN, Infinity, 2 ** 31, 3_000_000_000]) {
      const { error, logs } = await rejectionOf({ timeoutMs });
      expect(error).toBeInstanceOf(CrosscheckUsageError);
      expect(String(error)).toContain('timeoutMs must be from 1 to 2147483647 milliseconds');
      expect(logs).toEqual([]);
    }
  });

  test('accepts both timer bounds', async () => {
    expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
    for (const timeoutMs of [1, MAX_TIMEOUT_MS]) {
      const { error, logs } = await rejectionOf({ timeoutMs });
      expect(error).not.toBeInstanceOf(CrosscheckUsageError);
      expect(logs[0]).toContain('capturing ground truth');
    }
  });

  test('runs the selected adapters in the order given', async () => {
    const failingExec: Exec = {
      capture: () =>
        Promise.resolve({
          code: 1,
          signal: null,
          stderr: 'unavailable',
          stdout: '',
          timedOut: false,
        }),
      spawn: () => {
        throw new Error('order fake does not spawn');
      },
    };
    const orders: AdapterName[][] = [
      ['claude-code', 'inspector'],
      ['inspector', 'claude-code'],
    ];
    for (const adapters of orders) {
      const report = await runCrosscheck({
        adapters,
        exec: failingExec,
        pins: { inspector: INSPECTOR_PIN },
        target: STDIO_TARGET,
        timeoutMs: TIMEOUT_MS,
      });
      expect(report.adapters.map((adapter) => adapter.adapter)).toEqual(adapters);
    }
  });

  test('runs a relative programmatic target as given and persists ground truth', async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), 'crosscheck-e2e-'));
    try {
      const report = await runCrosscheck({
        adapters: [],
        artifactsDir,
        canary: CANARY,
        target: RELATIVE_STDIO_TARGET,
        timeoutMs: TIMEOUT_MS,
      });
      expect(report.pass).toBe(true);
      expect(report.failCount).toBe(0);
      expect(report.crosscheckVersion).toBe(VERSION);
      expect(report.reportVersion).toBe(1);
      expect((JSON.parse(toJsonReport(report)) as RunReport).reportVersion).toBe(1);
      expect(report.groundTruth.toolCount).toBe(6);
      expect(report.groundTruth.canary).toEqual({ attempted: true, detail: null, ok: true });
      expect(report.groundTruth.findings).toEqual([]);
      expect(report.groundTruth.depthLimitedPaths).toEqual([]);
      expect(report.target).toEqual({
        args: ['./tests/fixture-server/server.ts'],
        command: process.execPath,
        kind: 'stdio',
      });

      const saved = JSON.parse(
        await readFile(join(artifactsDir, 'ground-truth.json'), 'utf8'),
      ) as GroundTruth;
      expect(saved.tools).toHaveLength(6);

      const human = renderHumanReport(report);
      expect(human).toContain('crosscheck-fixture-server');
      expect(human).toContain('6 tools advertised');
      expect(human).not.toContain('Ground truth');
    } finally {
      await rm(artifactsDir, { force: true, recursive: true });
    }
  });

  test('ground-truth notes and depth limits are reported once, counted as info, and never baselined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-ground-truth-'));
    const baselinePath = join(dir, 'baseline.json');
    const chain = (levels: number): Record<string, unknown> =>
      levels === 0
        ? { type: 'integer' }
        : { properties: { next: chain(levels - 1) }, type: 'object' };
    const advertised = [
      {
        description: 'Legacy dialects.',
        inputSchema: {
          $schema: 'https://example.com/custom-dialect',
          properties: { a: chain(7) },
          type: 'object' as const,
        },
        name: 'legacy',
        outputSchema: {
          $schema: 'http://json-schema.org/draft-04/schema#',
          properties: { ok: { type: 'boolean' } },
          type: 'object' as const,
        },
      },
    ];
    const options: CrosscheckOptions = {
      adapters: ['inspector'],
      baselinePath,
      exec: inspectorFixtureExec([], (tools) => {
        tools.splice(0, tools.length, ...structuredClone(advertised));
      }),
      pins: { inspector: INSPECTOR_PIN },
      target: { ...STDIO_TARGET, env: { MCP_FIXTURE_TOOLS: JSON.stringify(advertised) } },
      timeoutMs: TIMEOUT_MS,
      updateBaseline: true,
    };
    try {
      const report = await runCrosscheck(options);
      for (const shown of [report, JSON.parse(toJsonReport(report)) as RunReport]) {
        expect(
          shown.groundTruth.findings.map((finding) => [
            finding.rule,
            finding.severity,
            finding.path,
            finding.evidence,
          ]),
        ).toEqual([
          [
            'unsupported-dialect',
            'info',
            'legacy',
            { declared: 'https://example.com/custom-dialect', kind: 'unsupported-dialect' },
          ],
          [
            'unsupported-dialect',
            'info',
            'output:legacy',
            { declared: 'http://json-schema.org/draft-04/schema#', kind: 'unsupported-dialect' },
          ],
        ]);
        expect(shown.groundTruth.depthLimitedPaths).toEqual([
          'legacy.a.next.next.next.next.next.next',
        ]);
        expect(shown.adapters[0]?.findings).toEqual([]);
        expect([shown.pass, shown.failCount, shown.infoCount]).toEqual([true, 0, 2]);
      }
      const human = renderHumanReport(report);
      expect(human.indexOf('Ground truth')).toBeLessThan(human.indexOf('inspector'));
      expect(human).toContain('[unsupported-dialect] output:legacy');
      expect(human).toContain('depth limit legacy.a.next.next.next.next.next.next');
      expect(human).toContain('2 new info note(s)');
      expect(JSON.parse(await readFile(baselinePath, 'utf8')).entries).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('a canary naming an unadvertised tool is a usage error', async () => {
    const run = runCrosscheck({
      adapters: [],
      canary: { args: {}, tool: 'not_a_tool' },
      target: STDIO_TARGET,
      timeoutMs: TIMEOUT_MS,
    });
    await expect(run).rejects.toThrow(CrosscheckUsageError);
  });

  test('baseline update then read acknowledges reviewed drift while changed evidence stays new', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-baseline-run-'));
    const baselinePath = join(dir, 'baseline.json');
    const options = {
      adapters: ['inspector'] as const,
      baselinePath,
      exec: inspectorFixtureExec(['mode']),
      pins: { inspector: INSPECTOR_PIN },
      target: STDIO_TARGET,
      timeoutMs: TIMEOUT_MS,
    };
    try {
      const updated = await runCrosscheck({
        ...options,
        adapters: [...options.adapters],
        updateBaseline: true,
      });
      expect(updated.pass).toBe(true);
      expect(updated.adapters[0]?.findings).toHaveLength(1);
      expect(updated.adapters[0]?.newFindings).toEqual([]);
      expect(updated.adapters[0]?.acknowledgedFindings).toHaveLength(1);
      const firstBytes = await readFile(baselinePath, 'utf8');

      const read = await runCrosscheck({ ...options, adapters: [...options.adapters] });
      expect(read.pass).toBe(true);
      expect(read.failCount).toBe(0);
      expect(read.acknowledgedCount).toBe(1);
      expect(renderHumanReport(read)).toContain('1 acknowledged finding(s)');
      const json = JSON.parse(toJsonReport(read)) as RunReport;
      expect(json.adapters[0]?.findings).toHaveLength(1);
      expect(json.adapters[0]?.newFindings).toEqual([]);
      expect(json.adapters[0]?.acknowledgedFindings).toHaveLength(1);
      expect(await readFile(baselinePath, 'utf8')).toBe(firstBytes);

      const changed = await runCrosscheck({
        ...options,
        adapters: [...options.adapters],
        exec: inspectorFixtureExec(['mode', 'repeat']),
      });
      expect(changed.pass).toBe(false);
      expect(changed.adapters[0]?.acknowledgedFindings).toHaveLength(1);
      expect(changed.adapters[0]?.newFindings).toHaveLength(1);

      const stale = await runCrosscheck({
        ...options,
        adapters: [...options.adapters],
        exec: inspectorFixtureExec(),
      });
      expect(stale.pass).toBe(true);
      expect(stale.staleCount).toBe(1);
      expect(stale.baselineDiagnostics[0]?.adapter).toBe('inspector');
      expect(renderHumanReport(stale)).toContain('Baseline diagnostics');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('altered descriptions and constraint values pass as info and round-trip through a baseline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-baseline-run-'));
    const baselinePath = join(dir, 'baseline.json');
    // A reviewed entry for a property whose advertisement carries no type at all.
    await writeFile(
      baselinePath,
      JSON.stringify({
        baselineVersion: 1,
        entries: [
          {
            adapter: 'inspector',
            evidence: { groundTruthType: null, kind: 'property-untyped' },
            path: 'echo_message.payload',
            rule: 'property-untyped',
          },
        ],
      }),
    );
    const options: CrosscheckOptions = {
      adapters: ['inspector'],
      baselinePath,
      exec: inspectorFixtureExec([], (tools) => {
        const echo = tools.find((tool) => tool.name === 'echo_message');
        if (echo === undefined) throw new Error('fixture lost echo_message');
        echo.description = 'Echo a message back as JSON.';
        (echo.inputSchema.properties?.repeat as Record<string, unknown>).maximum = 3;
      }),
      pins: { inspector: INSPECTOR_PIN },
      target: STDIO_TARGET,
      timeoutMs: TIMEOUT_MS,
    };
    try {
      const read = await runCrosscheck(options);
      expect(read.pass).toBe(true);
      expect(read.failCount).toBe(0);
      expect(read.infoCount).toBe(2);
      expect(read.staleCount).toBe(1);
      expect(
        read.adapters[0]?.newFindings.map((finding) => [
          finding.rule,
          finding.path,
          finding.evidence,
        ]),
      ).toEqual([
        [
          'description-altered',
          'echo_message',
          { change: 'truncated', kind: 'description-altered', subject: 'tool' },
        ],
        [
          'constraint-altered',
          'echo_message.repeat',
          { keywords: ['maximum'], kind: 'constraint-altered' },
        ],
      ]);

      const updated = await runCrosscheck({ ...options, updateBaseline: true });
      expect(updated.pass).toBe(true);
      expect(updated.acknowledgedCount).toBe(2);
      expect(updated.staleCount).toBe(0);
      const bytes = await readFile(baselinePath, 'utf8');
      expect(
        (JSON.parse(bytes) as { entries: { rule: string }[] }).entries.map((entry) => entry.rule),
      ).toEqual(['constraint-altered', 'description-altered']);

      const reread = await runCrosscheck(options);
      expect(reread.acknowledgedCount).toBe(2);
      expect(reread.adapters[0]?.newFindings).toEqual([]);
      expect(await readFile(baselinePath, 'utf8')).toBe(bytes);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('an update writes one entry per identity and acknowledges every finding it wrote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-baseline-run-'));
    const baselinePath = join(dir, 'baseline.json');
    const object = (properties: Record<string, object>, extra: Record<string, unknown> = {}) => ({
      properties,
      type: 'object' as const,
      ...extra,
    });
    // Tool `a` field `b.c` and tool `a.b` field `c` share the path `a.b.c`; `a` is listed twice.
    const toolA = (c: object) => ({
      description: 'A.',
      inputSchema: object({ b: object({ c }) }),
      name: 'a',
    });
    const toolAB = (c: object) => ({ description: 'AB.', inputSchema: object({ c }), name: 'a.b' });
    const edge = (bare: object, blank: object, extra: Record<string, unknown> = {}) => ({
      description: 'Edge.',
      inputSchema: object({ bare, blank }, extra),
      name: 'edge',
    });
    const described = { description: 'Described.', type: 'string' };
    const plain = { type: 'string' };
    const advertised = [
      toolA(described),
      toolAB(described),
      toolA(described),
      edge({ type: '' }, { type: '' }, { required: [''] }),
    ];
    const options: CrosscheckOptions = {
      adapters: ['inspector'],
      baselinePath,
      exec: inspectorFixtureExec([], (tools) => {
        tools.splice(0, tools.length, toolA(plain), toolAB(plain), edge({}, plain));
      }),
      pins: { inspector: INSPECTOR_PIN },
      target: { ...STDIO_TARGET, env: { MCP_FIXTURE_TOOLS: JSON.stringify(advertised) } },
      timeoutMs: TIMEOUT_MS,
    };
    try {
      const updated = await runCrosscheck({ ...options, updateBaseline: true });
      expect(
        updated.adapters[0]?.findings.map((finding) => [finding.path, finding.evidence]),
      ).toEqual([
        ['a.b.c', { kind: 'description-lost', subject: 'property' }],
        ['a.b.c', { kind: 'description-lost', subject: 'property' }],
        ['a.b.c', { kind: 'description-lost', subject: 'property' }],
        ['edge.bare', { groundTruthType: '', kind: 'property-untyped' }],
        ['edge.blank', { from: '', kind: 'property-retyped', to: 'string' }],
        ['edge', { kind: 'required-dropped', names: [''] }],
      ]);
      expect(updated.pass).toBe(true);
      expect(updated.acknowledgedCount).toBe(6);
      expect(updated.staleCount).toBe(0);
      const bytes = await readFile(baselinePath, 'utf8');
      expect((JSON.parse(bytes) as { entries: unknown[] }).entries).toHaveLength(4);

      const read = await runCrosscheck(options);
      expect(read.pass).toBe(true);
      expect(read.acknowledgedCount).toBe(6);
      expect(read.adapters[0]?.newFindings).toEqual([]);
      expect(read.staleCount).toBe(0);
      expect(await readFile(baselinePath, 'utf8')).toBe(bytes);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('a selected adapter without a surface leaves an existing baseline byte-identical', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-baseline-run-'));
    const baselinePath = join(dir, 'baseline.json');
    const original = '{\n  "baselineVersion": 1,\n  "entries": []\n}\n';
    await writeFile(baselinePath, original);
    const failedExec: Exec = {
      capture: () =>
        Promise.resolve({
          code: 1,
          signal: null,
          stderr: 'MCP handshake failed',
          stdout: '',
          timedOut: false,
        }),
      spawn: () => {
        throw new Error('inspector baseline fake does not spawn');
      },
    };
    try {
      const report = await runCrosscheck({
        adapters: ['inspector'],
        baselinePath,
        exec: failedExec,
        pins: { inspector: INSPECTOR_PIN },
        target: STDIO_TARGET,
        timeoutMs: TIMEOUT_MS,
        updateBaseline: true,
      });
      expect(report.pass).toBe(false);
      expect(report.adapters[0]?.newFindings[0]?.rule).toBe('handshake-failure');
      expect(await readFile(baselinePath, 'utf8')).toBe(original);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('ground-truth and adapter canary failures leave the baseline byte-identical', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-baseline-run-'));
    const baselinePath = join(dir, 'baseline.json');
    const original = '{\n  "baselineVersion": 1,\n  "entries": []\n}\n';
    await writeFile(baselinePath, original);
    try {
      await expect(
        runCrosscheck({
          adapters: [],
          baselinePath,
          target: { headers: {}, kind: 'http', url: 'http://127.0.0.1:1/mcp' },
          timeoutMs: 500,
          updateBaseline: true,
        }),
      ).rejects.toThrow();
      expect(await readFile(baselinePath, 'utf8')).toBe(original);

      let call = 0;
      const canaryFailureExec: Exec = {
        capture: () => {
          call += 1;
          return Promise.resolve({
            code: 0,
            signal: null,
            stderr: '',
            stdout:
              call === 1
                ? JSON.stringify({ tools: structuredClone(FIXTURE_TOOLS) })
                : JSON.stringify({ content: [{ text: 'rejected', type: 'text' }], isError: true }),
            timedOut: false,
          });
        },
        spawn: () => {
          throw new Error('inspector baseline fake does not spawn');
        },
      };
      const report = await runCrosscheck({
        adapters: ['inspector'],
        baselinePath,
        canary: CANARY,
        exec: canaryFailureExec,
        pins: { inspector: INSPECTOR_PIN },
        target: STDIO_TARGET,
        timeoutMs: TIMEOUT_MS,
        updateBaseline: true,
      });
      expect(report.adapters[0]?.newFindings[0]?.rule).toBe('canary-failed');
      expect(await readFile(baselinePath, 'utf8')).toBe(original);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
