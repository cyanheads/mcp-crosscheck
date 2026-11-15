/**
 * @file tests/e2e/codex.test.ts
 * Codex lane. The orchestration block runs `runCrosscheck` against the fixture
 * server with a fake `codex exec` posting to the adapter's real intercept, in
 * the default suite. The gated block boots the full Codex binary against the
 * fixture server through the provider intercept, on CROSSCHECK_E2E_CODEX=1. Run:
 * `CROSSCHECK_E2E_CODEX=1 bun test tests/e2e/codex.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCrosscheck } from '../../src/run.js';
import type { RunReport, TargetSpec } from '../../src/types.js';
import { type Exec, spawnManaged } from '../../src/util/exec.js';
import { getFreePort, waitForReady } from '../../src/util/net.js';
import { fakeCodexClient } from '../helpers/fake-clients.js';
import { codexExec, managed } from '../helpers/fake-exec.js';
import {
  canonicalEnvNames,
  FIXTURE_SERVER,
  launchProbes,
  REPO_ROOT,
  runCli,
  TIMEOUT_MS,
} from './harness.js';

const CODEX_HTTP_PIN = '0.147.0-alpha.6.5';
const CODEX_LANE = process.env.CROSSCHECK_E2E_CODEX === '1';
/** What Codex always sends, whatever the server: its own built-in tools. */
const BUILT_INS = [
  { name: 'exec_command', type: 'function' },
  { name: 'list_mcp_resources', type: 'function' },
];
const NO_MCP_TOOLS =
  'model request captured but it carried no MCP tools — the server may have failed to start under codex';

/** The fixture, advertising `tools` in place of its own. */
function fixtureAdvertising(tools: unknown[]): TargetSpec {
  return {
    args: [FIXTURE_SERVER],
    command: process.execPath,
    env: { MCP_FIXTURE_TOOLS: JSON.stringify(tools) },
    kind: 'stdio',
  };
}

/** A minimal advertised tool. */
const minimal = (name: string) => ({ inputSchema: { type: 'object' }, name });
/** Codex's namespace wrapper holding minimal tools under `names`. */
const namespaced = (names: string[]) => ({
  name: 'mcp__target',
  tools: names.map((name) => ({ name, parameters: { type: 'object' } })),
  type: 'namespace',
});

function runCodex(target: TargetSpec, exec: Exec, timeoutMs = TIMEOUT_MS): Promise<RunReport> {
  return runCrosscheck({
    adapters: ['codex'],
    exec,
    pins: { codex: '0.169.0' },
    target,
    timeoutMs,
  });
}

if (!CODEX_LANE) console.error('[e2e] codex lane skipped — set CROSSCHECK_E2E_CODEX=1');

describe('codex orchestration', () => {
  test('a capture with no MCP tools passes against a server that advertises none', async () => {
    const fake = fakeCodexClient([{ tools: BUILT_INS }]);
    const report = await runCodex(fixtureAdvertising([]), codexExec(fake.spawn));
    const [codex] = report.adapters;
    expect([report.pass, report.failCount, report.groundTruth.toolCount]).toEqual([true, 0, 0]);
    expect([codex?.status, codex?.statusDetail, codex?.toolCount, codex?.findings]).toEqual([
      'ok',
      null,
      0,
      [],
    ]);
    expect(codex?.canary).toEqual({
      attempted: false,
      detail: 'codex adapter is capture-only',
      ok: null,
    });
  });

  test('the same capture against a server that advertises tools is a handshake-failure', async () => {
    const fake = fakeCodexClient([{ tools: BUILT_INS }]);
    const report = await runCodex(
      { args: [FIXTURE_SERVER], command: process.execPath, env: {}, kind: 'stdio' },
      codexExec(fake.spawn),
    );
    const [codex] = report.adapters;
    expect(report.pass).toBe(false);
    expect([codex?.status, codex?.statusDetail, codex?.toolCount, codex?.canary]).toEqual([
      'handshake-failure',
      NO_MCP_TOOLS,
      null,
      null,
    ]);
    expect(codex?.findings).toEqual([
      {
        detail: `client could not complete the MCP handshake — ${NO_MCP_TOOLS}`,
        evidence: { kind: 'handshake-failure' },
        path: null,
        rule: 'handshake-failure',
        severity: 'fail',
      },
    ]);
  });

  test('a client that exits, or never sends a request, keeps its classification against a server with no tools', async () => {
    const exited = await runCodex(
      fixtureAdvertising([]),
      codexExec(() => managed({ exited: true, stderr: 'codex: unsupported platform' })),
    );
    expect([exited.adapters[0]?.status, exited.adapters[0]?.toolCount, exited.pass]).toEqual([
      'adapter-broken',
      null,
      false,
    ]);
    const silent = await runCodex(
      fixtureAdvertising([]),
      codexExec(() => managed({})),
      2_000,
    );
    expect([silent.adapters[0]?.status, silent.adapters[0]?.statusDetail, silent.pass]).toEqual([
      'handshake-failure',
      'no model request captured within 2000ms',
      false,
    ]);
  });

  test('tools Codex renames are matched under their rendered names and reported as tool-renamed', async () => {
    const advertised = ['files.read', 'files_read', 'get-weather', 'plain_tool'].map(minimal);
    // The names Codex 0.169.0 sends for this list.
    const fake = fakeCodexClient([
      {
        tools: [
          ...BUILT_INS,
          namespaced([
            'files_read_a5853431b20f',
            'files_read_2505a6bf744b',
            'get_weather',
            'plain_tool',
          ]),
        ],
      },
    ]);
    const report = await runCodex(fixtureAdvertising(advertised), codexExec(fake.spawn));
    const [codex] = report.adapters;
    expect([report.pass, codex?.status, codex?.toolCount]).toEqual([true, 'ok', 4]);
    expect(codex?.findings).toEqual([
      {
        detail:
          'tool name was hashed in rendering — the client renders it as "files_read_a5853431b20f"',
        evidence: { change: 'hashed', kind: 'tool-renamed' },
        path: 'files.read',
        rule: 'tool-renamed',
        severity: 'info',
      },
      {
        detail:
          'tool name was hashed in rendering — the client renders it as "files_read_2505a6bf744b"',
        evidence: { change: 'hashed', kind: 'tool-renamed' },
        path: 'files_read',
        rule: 'tool-renamed',
        severity: 'info',
      },
      {
        detail: 'tool name was sanitized in rendering — the client renders it as "get_weather"',
        evidence: { change: 'sanitized', kind: 'tool-renamed' },
        path: 'get-weather',
        rule: 'tool-renamed',
        severity: 'info',
      },
    ]);
  });

  test('a rendered name the model expects but the capture lacks is tool-missing, naming the expected name', async () => {
    const fake = fakeCodexClient([{ tools: [...BUILT_INS, namespaced(['files.read'])] }]);
    const report = await runCodex(
      fixtureAdvertising([minimal('files.read')]),
      codexExec(fake.spawn),
    );
    expect(report.adapters[0]?.findings).toEqual([
      expect.objectContaining({
        detail:
          'tool is missing from the rendered surface under its expected sanitized name "files_read"',
        path: 'files.read',
        rule: 'tool-missing',
        severity: 'fail',
      }),
    ]);
  });
});

/** Codex's raw identity for a stdio tool on the server keyed `target`. */
const identity = (name: string) => `target\0target\0\0${name}\0${name}`;
const sha12 = (input: string) => createHash('sha1').update(input).digest('hex').slice(0, 12);

describe.skipIf(!CODEX_LANE)('codex lane', () => {
  test('captures the converted tool surface through the provider intercept', async () => {
    const result = await runCli(
      ['--adapters', 'codex', '--json', '--', process.execPath, FIXTURE_SERVER],
      540_000,
    );
    const report = JSON.parse(result.stdout) as RunReport;
    const [codex] = report.adapters;
    console.error(`[e2e] codex lane exercised codex ${codex?.resolvedVersion}`);
    expect(codex?.adapter).toBe('codex');
    expect(codex?.status).toBe('ok');
    expect(codex?.toolCount).toBe(6);
    expect(codex?.canary).toEqual({
      attempted: false,
      detail: 'codex adapter is capture-only',
      ok: null,
    });
  }, 600_000);

  test('starts the target exactly as ground truth does, with every --env name intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-codex-probe-'));
    const probePath = join(dir, 'probe.jsonl');
    const passed = { 'A B': '1', 'MY.VAR': '1', MCP_FIXTURE_PROBE_PATH: probePath, 'Q"X': '1' };
    try {
      const result = await runCli(
        [
          '--adapters',
          'codex',
          ...Object.entries(passed).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
          '--json',
          '--',
          process.execPath,
          FIXTURE_SERVER,
        ],
        540_000,
      );
      const report = JSON.parse(result.stdout) as RunReport;
      expect([report.adapters[0]?.status, report.adapters[0]?.toolCount]).toEqual(['ok', 6]);
      const probes = await launchProbes(probePath);
      // Ground truth first, then each start under Codex.
      expect(probes.length).toBeGreaterThanOrEqual(2);
      for (const probe of probes) {
        expect(probe).toEqual({
          argv: [],
          cwd: REPO_ROOT,
          envNames: canonicalEnvNames(passed),
          home: process.env.HOME ?? null,
        });
        expect(probe.envNames).toEqual(expect.arrayContaining(['A B', 'MY.VAR', 'Q"X']));
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 600_000);

  test('a server that advertises no tools passes', async () => {
    const result = await runCli(
      [
        '--adapters',
        'codex',
        '--env',
        'MCP_FIXTURE_TOOLS=[]',
        '--json',
        '--',
        process.execPath,
        FIXTURE_SERVER,
      ],
      540_000,
    );
    const report = JSON.parse(result.stdout) as RunReport;
    const [codex] = report.adapters;
    expect([result.code, report.pass, codex?.status, codex?.toolCount, codex?.findings]).toEqual([
      0,
      true,
      'ok',
      0,
      [],
    ]);
  }, 600_000);

  test('every name Codex rewrites is matched by the rename model', async () => {
    const long = 'z'.repeat(116);
    const cut = `${'m'.repeat(100)}.${'n'.repeat(15)}`;
    // U+FF0E sorts before U+1F600 by code point and after it by UTF-16 unit; `rival`
    // sanitizes to exactly what `wide` is cut to, so the sort order decides who takes it.
    const wide = `x．${'y'.repeat(114)}`;
    const rival = `x😀${'y'.repeat(100)}_${sha12(identity(wide))}`;
    const names = [
      'files.read',
      'files_read',
      'get-weather',
      'plain_tool',
      'a-b',
      'a.b',
      'a_b',
      'é.x',
      'k'.repeat(115),
      cut,
      long,
      // What `long` would be cut to on its first attempt, so it has to retry.
      `${'z'.repeat(102)}_${sha12(identity(long))}`,
      rival,
      wide,
    ];
    const result = await runCli(
      [
        '--adapters',
        'codex',
        '--env',
        `MCP_FIXTURE_TOOLS=${JSON.stringify(names.map(minimal))}`,
        '--json',
        '--',
        process.execPath,
        FIXTURE_SERVER,
      ],
      540_000,
    );
    const report = JSON.parse(result.stdout) as RunReport;
    const [codex] = report.adapters;
    expect([codex?.status, codex?.toolCount]).toEqual(['ok', names.length]);
    expect(
      codex?.findings.map((finding) => [
        finding.rule,
        finding.path,
        finding.evidence.kind === 'tool-renamed' ? finding.evidence.change : null,
      ]),
    ).toEqual([
      ['tool-renamed', 'files.read', 'hashed'],
      ['tool-renamed', 'files_read', 'hashed'],
      ['tool-renamed', 'get-weather', 'sanitized'],
      ['tool-renamed', 'a-b', 'hashed'],
      ['tool-renamed', 'a.b', 'hashed'],
      ['tool-renamed', 'a_b', 'hashed'],
      ['tool-renamed', 'é.x', 'sanitized'],
      ['tool-renamed', cut, 'hashed'],
      ['tool-renamed', long, 'hashed'],
      ['tool-renamed', rival, 'hashed'],
      ['tool-renamed', wide, 'hashed'],
    ]);
    expect(result.code).toBe(0);
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
