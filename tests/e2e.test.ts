/**
 * @file tests/e2e.test.ts
 * End-to-end lanes against the bundled fixture server, layered by cost:
 *
 *   1. hermetic core — the programmatic API over stdio and streamable-http
 *   2. CLI process   — the real CLI: help, version, usage exit codes
 *   3. inspector     — CROSSCHECK_E2E_NETWORK=1 (npx resolves the client)
 *   4. mcpo          — CROSSCHECK_E2E_NETWORK=1 and `uv` on PATH
 *   5. codex         — CROSSCHECK_E2E_CODEX=1 (boots the full Codex binary)
 *   6. claude-code   — CROSSCHECK_E2E_CLAUDE_CODE=1 (installed Claude Code)
 *
 * Lanes 1 and 2 are what a bare `bun test` runs: no network, no binaries beyond
 * bun itself. The gated lanes resolve their clients at latest, so they belong in
 * a deliberate run rather than the default suite.
 *
 * Explicit-relative stdio targets are resolved at the orchestration boundary.
 * Adapter package runners still launch from a neutral scratch cwd.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureGroundTruth,
  runGroundTruthCanary,
  terminateGroundTruthSession,
} from '../src/ground-truth.js';
import { compareSurface } from '../src/invariants.js';
import { renderHumanReport, toJsonReport } from '../src/report.js';
import {
  type CrosscheckOptions,
  CrosscheckUsageError,
  MAX_TIMEOUT_MS,
  runCrosscheck,
} from '../src/run.js';
import { renderedPropertiesFromJsonSchema, renderedToolFromJsonSchema } from '../src/schema.js';
import type {
  AdapterName,
  CanarySpec,
  ErrorReport,
  GroundTruth,
  RenderedSurface,
  RunReport,
  TargetSpec,
} from '../src/types.js';
import { type Exec, type ExecResult, execCapture, spawnManaged } from '../src/util/exec.js';
import { getFreePort, waitForReady } from '../src/util/net.js';
import { VERSION } from '../src/version.js';
import { FIXTURE_TOOLS } from './fixture-server/tools.js';

const REPO_ROOT = join(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const FIXTURE_SERVER = join(import.meta.dir, 'fixture-server', 'server.ts');
/** Pinned so version resolution short-circuits instead of calling `npm view`. */
const INSPECTOR_PIN = '2.1.0';
const CODEX_HTTP_PIN = '0.147.0-alpha.6.5';
const TIMEOUT_MS = 30_000;

/** `repeat` is an integer: every adapter has to carry a non-string argument through unchanged. */
const CANARY: CanarySpec = { args: { message: 'probe', repeat: 2 }, tool: 'echo_message' };
/** The same canary as the `--canary '<tool>={json}'` flag spells it. */
const CANARY_FLAG = `${CANARY.tool}=${JSON.stringify(CANARY.args)}`;
/** The fixture's one tool with an `outputSchema`, on page 4 of 6 when the fixture pages one tool at a time. */
const NESTED_CANARY: CanarySpec = { args: { config: { retries: 1 } }, tool: 'nested_config' };
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

const NETWORK_LANES = process.env.CROSSCHECK_E2E_NETWORK === '1';
const CODEX_LANE = process.env.CROSSCHECK_E2E_CODEX === '1';
const CLAUDE_CODE_LANE = process.env.CROSSCHECK_E2E_CLAUDE_CODE === '1';
const HAS_UV = Bun.which('uv') !== null;

/** Bun's reporter prints a skip count but not the names, so each gate says why it is off. */
if (!NETWORK_LANES) {
  console.error('[e2e] inspector and mcpo lanes skipped — set CROSSCHECK_E2E_NETWORK=1');
} else if (!HAS_UV) {
  console.error('[e2e] mcpo lane skipped — uv is not on PATH');
}
if (!CODEX_LANE) console.error('[e2e] codex lane skipped — set CROSSCHECK_E2E_CODEX=1');
if (!CLAUDE_CODE_LANE) {
  console.error('[e2e] claude-code lane skipped — set CROSSCHECK_E2E_CLAUDE_CODE=1');
}

function runCli(
  args: string[],
  timeoutMs = 60_000,
  env: Record<string, string> = {},
): Promise<ExecResult> {
  return execCapture(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, timeoutMs });
}

/** Refuses every connection, so a run that gets past validation fails fast at ground truth. */
const UNREACHABLE_URL = 'http://127.0.0.1:1/mcp';

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

  test('canonicalizes a relative programmatic target and persists ground truth', async () => {
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
        args: [FIXTURE_SERVER],
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

describe('CLI process lane', () => {
  test('--help exits 0 and prints the usage block', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mcp-crosscheck [flags]');
    expect(result.stdout).toContain('claude-code');
  });

  test('--help names every artifact file and marks --env stdio only', async () => {
    const { stdout } = await runCli(['--help']);
    for (const file of [
      'report.json',
      'ground-truth.json',
      'mcpo.openapi.json',
      'codex.request.json',
      'claude-code.request.json',
    ]) {
      expect(stdout).toContain(file);
    }
    expect(stdout).toMatch(/--env <K=V>.*stdio only/);
  });

  test('--help and --version print text even with --json: they are not runs', async () => {
    const help = await runCli(['--json', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('mcp-crosscheck [flags]');
    const version = await runCli(['--json', '--version']);
    expect(version.stdout.trim()).toBe(VERSION);
  });

  test('--version prints the package version', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  const STDIO = ['--', 'node', 'server.js'];
  const UNKNOWN_ADAPTER = (name: string) =>
    `unknown adapter "${name}" — known adapters: inspector, mcpo, codex, claude-code`;
  const TIMEOUT_USAGE = (raw: string) =>
    `--timeout must be a number of seconds from 0.001 to 2147483.647 (about 24.8 days), got: ${raw}`;
  const URL_USAGE = 'target URL must be an http: or https: URL, got: ';
  const USAGE_ERRORS: { args: string[]; message?: string; name: string }[] = [
    { args: [], name: 'no target at all' },
    { args: ['--adapters', 'nope', ...STDIO], name: 'an unknown adapter name' },
    ...['toString', 'constructor', '__proto__'].map((name) => ({
      args: ['--adapters', name, ...STDIO],
      message: UNKNOWN_ADAPTER(name),
      name: `the inherited adapter name ${name}`,
    })),
    ...['constructor', '__proto__'].map((name) => ({
      args: ['--pin', `${name}=1`, ...STDIO],
      message: `--pin names unknown adapter "${name}"`,
      name: `a --pin naming the inherited key ${name}`,
    })),
    {
      args: ['--adapters', 'inspector,inspector', ...STDIO],
      message: 'adapter "inspector" is selected more than once',
      name: 'a repeated adapter name',
    },
    { args: ['--canary', 'malformed', ...STDIO], name: 'a canary without `=`' },
    {
      args: ['--canary', 'echo_message=[1,2]', ...STDIO],
      name: 'canary args that are not a JSON object',
    },
    {
      args: ['--http', UNREACHABLE_URL, ...STDIO],
      name: '--http alongside a stdio command',
    },
    {
      args: ['--http', UNREACHABLE_URL, '--env', 'FOO=bar'],
      message: '--env is supported only with a stdio target',
      name: '--env with an HTTP target',
    },
    {
      args: ['--http', 'notaurl'],
      message: `${URL_USAGE}notaurl`,
      name: 'an unparseable --http URL',
    },
    {
      args: ['--http', 'ftp://127.0.0.1:1/mcp'],
      message: `${URL_USAGE}ftp://127.0.0.1:1/mcp`,
      name: 'a non-HTTP --http URL',
    },
    {
      args: ['--adpaters', 'inspector', ...STDIO],
      message: "Unknown option '--adpaters'",
      name: 'an unknown flag',
    },
    { args: ['--timeout'], message: 'argument missing', name: 'a flag missing its value' },
    {
      args: ['--update-baseline=yes', ...STDIO],
      message: "Option '--update-baseline' does not take an argument",
      name: 'a value on a boolean flag',
    },
    { args: ['--timeout', '0', ...STDIO], name: 'a non-positive --timeout' },
    {
      args: ['--timeout', 'soon', ...STDIO],
      message: TIMEOUT_USAGE('soon'),
      name: 'a non-numeric --timeout',
    },
    {
      args: ['--timeout', '3000000', ...STDIO],
      message: TIMEOUT_USAGE('3000000'),
      name: 'a --timeout past the timer range',
    },
    {
      args: ['--timeout', '0.0001', ...STDIO],
      message: TIMEOUT_USAGE('0.0001'),
      name: 'a --timeout below one millisecond',
    },
  ];

  for (const scenario of USAGE_ERRORS) {
    test(`exits 2 on ${scenario.name}`, async () => {
      const result = await runCli(scenario.args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('mcp-crosscheck:');
      if (scenario.message !== undefined) expect(result.stderr).toContain(scenario.message);
      expect(result.stderr).not.toContain('capturing ground truth');
      expect(result.stdout).toBe('');
    });
  }

  test('--adapters and --pin with valid names pass validation and reach ground truth', async () => {
    const result = await runCli([
      '--adapters',
      'mcpo,inspector',
      '--pin',
      'mcpo=0.0.20',
      '--timeout',
      '2147483.647',
      '--http',
      UNREACHABLE_URL,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('capturing ground truth');
  });

  test('--env still reaches a stdio server', async () => {
    // Switching the fixture to HTTP through --env leaves the stdio client unanswered.
    const port = await getFreePort();
    const result = await runCli([
      '--env',
      'MCP_TRANSPORT_TYPE=http',
      '--env',
      `MCP_HTTP_PORT=${port}`,
      '--timeout',
      '2',
      '--adapters',
      'claude-code',
      '--',
      process.execPath,
      FIXTURE_SERVER,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ground-truth client timed out after 2000ms');
  }, 30_000);

  describe('--json', () => {
    function errorDocument(stdout: string): ErrorReport {
      return JSON.parse(stdout) as ErrorReport;
    }

    test('a usage error prints one usage error document and exits 2', async () => {
      const result = await runCli(['--json', '--adapters', 'bogus', ...STDIO]);
      expect(result.code).toBe(2);
      expect(errorDocument(result.stdout)).toEqual({
        error: { kind: 'usage', message: UNKNOWN_ADAPTER('bogus') },
        reportVersion: 1,
      });
      expect(result.stderr).toContain(`mcp-crosscheck: ${UNKNOWN_ADAPTER('bogus')}`);
    });

    test('a flag-parse error still answers in JSON when --json was given', async () => {
      for (const args of [
        ['--json', '--adpaters', 'inspector', ...STDIO],
        ['--adapters', 'inspector', '--json', '--timeout'],
        ['--json=yes', ...STDIO],
      ]) {
        const result = await runCli(args);
        expect(result.code).toBe(2);
        const document = errorDocument(result.stdout);
        expect(document.reportVersion).toBe(1);
        expect(document.error.kind).toBe('usage');
      }
    });

    test('--json after the `--` terminator belongs to the server, not crosscheck', async () => {
      const result = await runCli(['--adapters', 'bogus', ...STDIO, '--json']);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    });

    test('a ground-truth failure prints a runtime error document without header values', async () => {
      const port = await getFreePort();
      const secret = 'json-error-secret';
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
          failFast: () =>
            proc.hasExited() ? `fixture server exited — ${proc.stderrTail()}` : null,
          intervalMs: 50,
          probe: () => Promise.resolve(proc.stderrTail().includes('streamable-http on')),
          timeoutMs: TIMEOUT_MS,
        });
        if (failure !== null) throw new Error(failure);
        const result = await runCli([
          '--json',
          '--adapters',
          'inspector',
          '--header',
          `X-Fixture-Auth: ${secret}`,
          '--http',
          `http://127.0.0.1:${port}/mcp`,
        ]);
        expect(result.code).toBe(1);
        const document = errorDocument(result.stdout);
        expect(document.reportVersion).toBe(1);
        expect(document.error.kind).toBe('runtime');
        expect(document.error.message).toContain('[REDACTED]');
        expect(result.stdout).not.toContain(secret);
        expect(result.stderr).not.toContain(secret);
      } finally {
        proc.kill();
      }
    }, 30_000);

    test('a report run prints exactly one versioned report document', async () => {
      // An empty PATH makes the installed-client lookup fail without launching anything.
      const emptyPath = await mkdtemp(join(tmpdir(), 'crosscheck-empty-path-'));
      try {
        const result = await runCli(
          ['--json', '--adapters', 'claude-code', '--', process.execPath, FIXTURE_SERVER],
          60_000,
          { PATH: emptyPath },
        );
        expect(result.code).toBe(1);
        const report = JSON.parse(result.stdout) as RunReport;
        expect(report.reportVersion).toBe(1);
        expect(report.adapters.map((adapter) => adapter.status)).toEqual(['adapter-broken']);
      } finally {
        await rm(emptyPath, { force: true, recursive: true });
      }
    }, 30_000);

    test('without --json a failing run leaves stdout empty', async () => {
      const result = await runCli(['--adapters', 'inspector', '--http', UNREACHABLE_URL]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
    });
  });

  test('removes the scratch directory when the artifacts directory cannot be created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-scratch-cleanup-'));
    const scratchRoot = join(dir, 'tmp');
    const blocker = join(dir, 'blocker');
    try {
      await mkdir(scratchRoot);
      await writeFile(blocker, 'a file where the artifacts parent should be');
      const result = await runCli(
        ['--adapters', 'inspector', '--artifacts', join(blocker, 'artifacts'), ...STDIO],
        60_000,
        { TEMP: scratchRoot, TMP: scratchRoot, TMPDIR: scratchRoot },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain('capturing ground truth');
      const leftovers = (await readdir(scratchRoot)).filter((name) =>
        name.startsWith('mcp-crosscheck-'),
      );
      expect(leftovers).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('exits 2 when the canary names a tool the server never advertised', async () => {
    const result = await runCli(['--canary', 'nope={}', '--', process.execPath, FIXTURE_SERVER]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not advertised by the server');
  });

  test('exits 2 when the canary result violates its output schema, before any adapter runs', async () => {
    // An empty PATH would make the installed-client lookup fail, had the adapter been reached.
    const emptyPath = await mkdtemp(join(tmpdir(), 'crosscheck-empty-path-'));
    try {
      const result = await runCli(
        [
          '--adapters',
          'claude-code',
          '--canary',
          `${NESTED_CANARY.tool}=${JSON.stringify(NESTED_CANARY.args)}`,
          '--env',
          'MCP_FIXTURE_INVALID_OUTPUT=mismatch',
          '--',
          process.execPath,
          FIXTURE_SERVER,
        ],
        60_000,
        { PATH: emptyPath },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Structured content does not match the tool's output schema");
      expect(result.stderr).not.toContain('running adapter');
    } finally {
      await rm(emptyPath, { force: true, recursive: true });
    }
  }, 30_000);

  test('exits 2 when claude-code is selected for an HTTP target', async () => {
    const result = await runCli(['--adapters', 'claude-code', '--http', 'http://127.0.0.1:1/mcp']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('claude-code adapter supports stdio targets only');
  });

  test('validates repeatable HTTP headers without echoing supplied values', async () => {
    const secret = 'must-not-appear';
    const scenarios = [
      ['--header', `Bad Name: ${secret}`],
      ['--header', `X-Test: ${secret}`, '--header', 'x-test: duplicate'],
      ['--header', `NoColon${secret}`],
      ['--header', `: ${secret}`],
      ['--header', 'X-Empty:   '],
    ];
    for (const flags of scenarios) {
      const result = await runCli([...flags, '--http', 'http://127.0.0.1:1/mcp']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--header');
      expect(result.stderr).not.toContain(secret);
    }
    const stdio = await runCli([
      '--header',
      `Authorization: Bearer ${secret}`,
      '--',
      process.execPath,
      FIXTURE_SERVER,
    ]);
    expect(stdio.code).toBe(2);
    expect(stdio.stderr).not.toContain(secret);
  });

  test('validates coupled baseline flags before running the target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-baseline-cli-'));
    const missing = join(dir, 'missing.json');
    try {
      const readOnly = await runCli([
        '--baseline',
        missing,
        '--',
        process.execPath,
        FIXTURE_SERVER,
      ]);
      // Whole-result matches: a failure prints signal, spawnErrorCode, and stderr, not just the code.
      expect(readOnly).toMatchObject({ code: 2 });
      const uncoupled = await runCli(['--update-baseline', '--', process.execPath, FIXTURE_SERVER]);
      expect(uncoupled).toMatchObject({ code: 2 });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('rejects a normalized baseline path that aliases a generated report artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-baseline-alias-'));
    try {
      const result = await runCli([
        '--adapters',
        'claude-code',
        '--artifacts',
        dir,
        '--baseline',
        join(dir, 'nested', '..', 'report.json'),
        '--update-baseline',
        '--http',
        'http://127.0.0.1:1/mcp',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('baseline');
      expect(result.stderr).toContain('report.json');
      expect(result.stderr).toContain('artifact');
      expect(result.stderr).not.toContain('supports stdio targets only');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe.skipIf(!NETWORK_LANES)('inspector lane', () => {
  test('resolves the relative fixture target before the neutral-cwd adapter run', async () => {
    const result = await runCli(
      [
        '--adapters',
        'inspector',
        '--pin',
        `inspector=${INSPECTOR_PIN}`,
        '--canary',
        CANARY_FLAG,
        '--json',
        '--',
        process.execPath,
        './tests/fixture-server/server.ts',
      ],
      300_000,
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as RunReport;
    expect(report.reportVersion).toBe(1);
    expect(report.pass).toBe(true);
    expect(report.target).toEqual({
      args: [FIXTURE_SERVER],
      command: process.execPath,
      kind: 'stdio',
    });
    const [inspector] = report.adapters;
    expect(inspector?.adapter).toBe('inspector');
    expect(inspector?.status).toBe('ok');
    expect(inspector?.resolvedVersion).toBe(INSPECTOR_PIN);
    expect(inspector?.toolCount).toBe(6);
    expect(inspector?.canary?.ok).toBe(true);
    expect(inspector?.findings).toEqual([]);
  }, 360_000);

  /**
   * The encoding claim, measured against the client itself: the fixture echoes
   * back the arguments it received, so a deep equality against what went in
   * proves each shape survived. `--tool-arg key=value` would coerce the string
   * `"123"` to a number and reject the empty one before the call went out.
   */
  test('--tool-args-json delivers every argument shape verbatim', async () => {
    const args = {
      blank: '',
      count: 3,
      equals: 'left=right',
      flag: true,
      message: '123',
      nested: { depth: { value: 1 } },
    };
    const result = await execCapture(
      'npx',
      [
        '-y',
        `@modelcontextprotocol/inspector@${INSPECTOR_PIN}`,
        '--cli',
        process.execPath,
        FIXTURE_SERVER,
        '--method',
        'tools/call',
        '--tool-name',
        'echo_message',
        '--tool-args-json',
        JSON.stringify(args),
      ],
      // A neutral cwd, the same reason the adapter runs package runners from one.
      { cwd: tmpdir(), timeoutMs: 300_000 },
    );
    expect(result.code).toBe(0);
    const body = result.stdout.trim();
    const call = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as {
      content: { text: string }[];
    };
    expect(JSON.parse(call.content[0]?.text ?? '{}')).toEqual(args);
  }, 360_000);
});

describe.skipIf(!NETWORK_LANES || !HAS_UV)('mcpo lane', () => {
  /**
   * The verdict belongs to the converter, not the harness: mcpo drops type
   * information the fixture deliberately carries, so this asserts the
   * classification and the rendered surface rather than a pass.
   */
  test('renders the fixture through the OpenAPI proxy, or classifies a broken upstream', async () => {
    const result = await runCli(
      [
        '--adapters',
        'mcpo',
        // mcpo leaves its `mcp` dependency unbounded; the constraint is the
        // documented escape hatch for a resolve that would otherwise import-fail.
        '--mcpo-with',
        'mcp<2',
        '--canary',
        CANARY_FLAG,
        '--json',
        '--',
        process.execPath,
        FIXTURE_SERVER,
      ],
      300_000,
    );
    const report = JSON.parse(result.stdout) as RunReport;
    const [mcpo] = report.adapters;
    expect(mcpo?.adapter).toBe('mcpo');
    expect(mcpo?.resolvedVersion).not.toBeNull();
    if (mcpo?.status === 'adapter-broken') {
      expect(mcpo.findings.map((finding) => finding.rule)).toEqual(['adapter-broken']);
      return;
    }
    expect(mcpo?.status).toBe('ok');
    expect(mcpo?.toolCount).toBe(6);
    expect(mcpo?.canary?.ok).toBe(true);
  }, 360_000);
});

describe.skipIf(!CODEX_LANE)('codex lane', () => {
  test('captures the converted tool surface through the provider intercept', async () => {
    const result = await runCli(
      ['--adapters', 'codex', '--json', '--', process.execPath, FIXTURE_SERVER],
      540_000,
    );
    const report = JSON.parse(result.stdout) as RunReport;
    const [codex] = report.adapters;
    expect(codex?.adapter).toBe('codex');
    expect(codex?.status).toBe('ok');
    expect(codex?.toolCount).toBe(6);
    expect(codex?.canary).toEqual({
      attempted: false,
      detail: 'codex adapter is capture-only',
      ok: null,
    });
  }, 600_000);

  test('captures a protected streamable-http target with environment-backed headers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-codex-http-'));
    const recordPath = join(dir, 'requests.jsonl');
    const port = await getFreePort();
    const secret = 'codex-http-dummy';
    const proc = spawnManaged(process.execPath, [FIXTURE_SERVER], {
      env: {
        MCP_HTTP_PORT: String(port),
        MCP_HTTP_RECORD_PATH: recordPath,
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
      const result = await runCli(
        [
          '--adapters',
          'codex',
          '--pin',
          `codex=${CODEX_HTTP_PIN}`,
          '--header',
          `X-Fixture-Auth: ${secret}`,
          '--artifacts',
          dir,
          '--json',
          '--http',
          `http://127.0.0.1:${port}/mcp`,
        ],
        540_000,
      );
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as RunReport;
      const [codex] = report.adapters;
      expect(codex?.resolvedVersion).toBe(CODEX_HTTP_PIN);
      expect(codex?.status).toBe('ok');
      expect(codex?.toolCount).toBe(6);
      expect(codex?.findings).toHaveLength(6);
      expect(codex?.findings.every((finding) => finding.rule === 'constraint-dropped')).toBe(true);
      expect(result.stdout).not.toContain(secret);
      expect(await readFile(join(dir, 'report.json'), 'utf8')).not.toContain(secret);
      expect(await readFile(join(dir, 'codex.request.json'), 'utf8')).not.toContain(secret);
    } finally {
      proc.kill();
      await rm(dir, { force: true, recursive: true });
    }
  }, 600_000);
});

describe.skipIf(!CLAUDE_CODE_LANE)('claude-code lane', () => {
  test('captures the converted tool surface through the isolated base-URL intercept', async () => {
    // Claude Code updates itself, so the lane exercises whichever release is installed.
    const installed = Bun.spawnSync(['claude', '--version']).stdout.toString().split(' ')[0];
    const result = await runCli(
      ['--adapters', 'claude-code', '--json', '--', process.execPath, FIXTURE_SERVER],
      540_000,
    );
    const report = JSON.parse(result.stdout) as RunReport;
    const [claudeCode] = report.adapters;
    expect(claudeCode?.adapter).toBe('claude-code');
    expect(claudeCode?.resolvedVersion).toBe(installed);
    expect(claudeCode?.status).toBe('ok');
    expect(claudeCode?.toolCount).toBe(6);
    expect(claudeCode?.canary).toEqual({
      attempted: false,
      detail: 'claude-code adapter is capture-only',
      ok: null,
    });
    expect(claudeCode?.findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['description-altered', 'union_modes'],
      ['anyof-ignored', 'union_modes'],
      ['description-altered', 'branch_only_fields'],
      ['anyof-ignored', 'branch_only_fields'],
    ]);
  }, 600_000);
});
