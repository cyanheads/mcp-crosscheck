/**
 * @file tests/e2e/inspector.test.ts
 * Inspector lane. The orchestration block runs in the default suite: the
 * adapter inside `runCrosscheck` against the fixture server, with a fake `Exec`
 * or an empty `PATH` standing in for the client. The live lane, gated on
 * CROSSCHECK_E2E_NETWORK=1, runs the real MCP Inspector CLI resolved through
 * npx: `CROSSCHECK_E2E_NETWORK=1 bun test tests/e2e/inspector.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCrosscheck } from '../../src/run.js';
import type { CanarySpec, RunReport, TargetSpec } from '../../src/types.js';
import { createNodeExec, type Exec, execCapture } from '../../src/util/exec.js';
import { FIXTURE_TOOLS } from '../fixture-server/tools.js';
import { managed } from '../helpers/fake-exec.js';
import {
  CANARY,
  CANARY_FLAG,
  canonicalEnvNames,
  FIXTURE_SERVER,
  INSPECTOR_PIN,
  launchProbes,
  NETWORK_LANES,
  REPO_ROOT,
  runCli,
  TIMEOUT_MS,
} from './harness.js';

/** Under `bun test` the launcher runs from source, beside the module that resolves it. */
const LAUNCHER = join(REPO_ROOT, 'src', 'launch-target.ts');
const STDIO_TARGET: TargetSpec = {
  args: [FIXTURE_SERVER],
  command: process.execPath,
  env: {},
  kind: 'stdio',
};

/** Bun's reporter prints a skip count but not the names, so each gate says why it is off. */
if (!NETWORK_LANES)
  console.error('[e2e] inspector and mcpo lanes skipped — set CROSSCHECK_E2E_NETWORK=1');

/** An Inspector fake answering `tools/list` with the fixture tools and `tools/call` with an echo. */
function fixtureInspectorExec(calls: string[][]): Exec {
  return {
    capture: (_command, args) => {
      calls.push(args);
      const result = args.includes('tools/list')
        ? { tools: FIXTURE_TOOLS }
        : { content: [{ text: '{}', type: 'text' }] };
      return Promise.resolve({
        code: 0,
        signal: null,
        stderr: '',
        stdout: JSON.stringify(result),
        timedOut: false,
      });
    },
    spawn: () => {
      throw new Error('the inspector fake does not spawn');
    },
  };
}

/** Fake `uvx mcpo` serving a one-tool OpenAPI document on the port it is handed. */
const servingMcpo: Exec['spawn'] = (_command, args) => {
  const port = Number(args[args.indexOf('--port') + 1]);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ paths: { '/echo_message': { post: { description: 'Echo.' } } } }),
    );
  });
  server.listen(port, '127.0.0.1');
  return managed({ onKill: () => server.close() });
};

describe('inspector orchestration', () => {
  test('stdio tools/list and canary invocations carry the launcher and none of the target', async () => {
    const calls: string[][] = [];
    const secret = 'env-value-never-on-a-command-line';
    const report = await runCrosscheck({
      adapters: ['inspector'],
      canary: CANARY,
      exec: fixtureInspectorExec(calls),
      pins: { inspector: INSPECTOR_PIN },
      target: {
        args: [FIXTURE_SERVER, '--flag', 'x', '-e', 'y'],
        command: process.execPath,
        env: { CROSSCHECK_SECRET: secret },
        kind: 'stdio',
      },
      timeoutMs: TIMEOUT_MS,
    });
    expect([report.adapters[0]?.status, report.adapters[0]?.canary?.ok]).toEqual(['ok', true]);
    expect(calls).toHaveLength(2);
    const specPath = calls[0]?.[calls[0].indexOf('--cli') + 3] ?? '';
    expect(specPath).toEndWith('target-launch.json');
    for (const args of calls) {
      expect(args.slice(args.indexOf('--cli') + 1, args.indexOf('--method'))).toEqual([
        process.execPath,
        LAUNCHER,
        specPath,
      ]);
      expect(args).not.toContain('-e');
      expect(args).not.toContain('--flag');
      expect(args).not.toContain(FIXTURE_SERVER);
    }
    expect(JSON.stringify(calls)).not.toContain(secret);
  });

  test('a capture-failure under --update-baseline leaves the baseline byte-identical', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-capture-baseline-'));
    const baselinePath = join(dir, 'baseline.json');
    // Non-canonical formatting and an entry this run would call stale: any rewrite changes the bytes.
    const original = `{"baselineVersion":1,"entries":[{"adapter":"inspector","evidence":{"kind":"tool-missing"},"path":"echo_message","rule":"tool-missing"}]}`;
    await writeFile(baselinePath, original);
    const exec: Exec = {
      capture: () =>
        Promise.resolve({
          code: 0,
          signal: null,
          stderr: '',
          stdout: '{"tools":[{"name":"echo_mess',
          stdoutTruncated: true,
          timedOut: false,
        }),
      spawn: () => {
        throw new Error('the inspector fake does not spawn');
      },
    };
    try {
      const report = await runCrosscheck({
        adapters: ['inspector'],
        baselinePath,
        exec,
        pins: { inspector: INSPECTOR_PIN },
        target: STDIO_TARGET,
        timeoutMs: TIMEOUT_MS,
        updateBaseline: true,
      });
      const [inspector] = report.adapters;
      expect(inspector?.status).toBe('capture-failure');
      expect(inspector?.newFindings.map((finding) => finding.rule)).toEqual(['capture-failure']);
      expect(await readFile(baselinePath, 'utf8')).toBe(original);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('a synchronous spawn failure breaks Inspector alone, and mcpo still runs', async () => {
    const e2big = Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG', syscall: 'spawn' });
    const refusing = createNodeExec({
      spawn: () => {
        throw e2big;
      },
    });
    const report = await runCrosscheck({
      adapters: ['inspector', 'mcpo'],
      exec: { capture: refusing.capture, spawn: servingMcpo },
      pins: { inspector: INSPECTOR_PIN, mcpo: '0.0.20' },
      target: STDIO_TARGET,
      timeoutMs: TIMEOUT_MS,
    });
    expect(report.adapters.map((adapter) => [adapter.adapter, adapter.status])).toEqual([
      ['inspector', 'adapter-broken'],
      ['mcpo', 'ok'],
    ]);
    expect(report.adapters[0]?.statusDetail).toBe('npx could not start — Error: spawn E2BIG');
  });

  test('with npx and uvx missing from PATH, each adapter names what provides its runner', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'crosscheck-empty-path-'));
    try {
      const result = await runCli(
        [
          '--json',
          '--adapters',
          'inspector,mcpo',
          '--pin',
          `inspector=${INSPECTOR_PIN}`,
          '--pin',
          'mcpo=0.0.20',
          '--',
          process.execPath,
          FIXTURE_SERVER,
        ],
        60_000,
        { PATH: emptyPath },
      );
      const report = JSON.parse(result.stdout) as RunReport;
      expect(
        report.adapters.map((adapter) => [adapter.adapter, adapter.status, adapter.statusDetail]),
      ).toEqual([
        ['inspector', 'adapter-broken', 'npx is not on PATH — it ships with npm, part of Node.js'],
        [
          'mcpo',
          'adapter-broken',
          'uvx is not on PATH — it ships with uv (https://docs.astral.sh/uv/)',
        ],
      ]);
    } finally {
      await rm(emptyPath, { force: true, recursive: true });
    }
  }, 30_000);
});

/** String arguments only, so a pre-2.0.0 Inspector's `--tool-arg` can carry the canary too. */
const STRING_CANARY: CanarySpec = { args: { message: 'probe' }, tool: 'echo_message' };

describe.skipIf(!NETWORK_LANES)('inspector lane', () => {
  test('runs an explicit-relative fixture target as given while Inspector runs from the scratch directory', async () => {
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
      args: ['./tests/fixture-server/server.ts'],
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
   * Launch parity, measured against each client release: 2.1.0 (this lane's
   * pin), 2.8.0 (which parses dash-prefixed target arguments as its own),
   * 0.16.5 (which forwards its whole environment), and whatever latest
   * resolves to. The fixture records one probe line per start — ground truth,
   * its canary, Inspector's `tools/list`, and Inspector's canary — and every
   * line must match ground truth's launch. The target path is bare relative,
   * resolved from the test's own working directory, and `CROSSCHECK_E2E_NETWORK`
   * is exported in the shell running the lane but never passed with `--env`.
   */
  for (const pin of ['2.1.0', '2.8.0', '0.16.5', null]) {
    test(`inspector ${pin ?? 'unpinned'} starts the target exactly as ground truth does`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'crosscheck-inspector-parity-'));
      const probePath = join(dir, 'probe.jsonl');
      const env = { CROSSCHECK_PASSED: 'from --env', MCP_FIXTURE_PROBE_PATH: probePath };
      try {
        const report = await runCrosscheck({
          adapters: ['inspector'],
          canary: STRING_CANARY,
          pins: pin === null ? {} : { inspector: pin },
          target: {
            args: ['tests/fixture-server/server.ts', '--flag', 'x', '-e', 'y'],
            command: process.execPath,
            env,
            kind: 'stdio',
          },
          timeoutMs: 300_000,
        });
        const [inspector] = report.adapters;
        expect([inspector?.status, inspector?.statusDetail]).toEqual(['ok', null]);
        expect(inspector?.canary).toEqual({ attempted: true, detail: null, ok: true });
        expect(inspector?.findings).toEqual([]);
        if (pin === null) {
          expect(inspector?.resolvedVersion).toMatch(/^\d+\.\d+\.\d+/);
          // Latest floats, so the lane names the release a dated measurement would cite.
          console.error(`[e2e] inspector unpinned exercised ${inspector?.resolvedVersion}`);
        } else {
          expect(inspector?.resolvedVersion).toBe(pin);
        }

        const probes = await launchProbes(probePath);
        expect(probes).toEqual(
          Array.from({ length: 4 }, () => ({
            argv: ['--flag', 'x', '-e', 'y'],
            cwd: process.cwd(),
            envNames: canonicalEnvNames(env),
            home: process.env.HOME ?? null,
          })),
        );
        expect(probes[0]?.envNames).not.toContain('CROSSCHECK_E2E_NETWORK');
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    }, 360_000);
  }

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
