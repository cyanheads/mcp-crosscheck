/**
 * @file tests/e2e.test.ts
 * End-to-end lanes against the bundled fixture server, layered by cost:
 *
 *   1. hermetic core — the programmatic API over stdio and streamable-http
 *   2. CLI process   — the real CLI: help, version, usage exit codes
 *   3. inspector     — CROSSCHECK_E2E_NETWORK=1 (npx resolves the client)
 *   4. mcpo          — CROSSCHECK_E2E_NETWORK=1 and `uv` on PATH
 *   5. codex         — CROSSCHECK_E2E_CODEX=1 (boots the full Codex binary)
 *
 * Lanes 1 and 2 are what a bare `bun test` runs: no network, no binaries beyond
 * bun itself. The gated lanes resolve their clients at latest, so they belong in
 * a deliberate run rather than the default suite.
 *
 * Every spawned target path is absolute: adapters run package runners from a
 * neutral scratch cwd, so a relative target would resolve against the wrong root.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureGroundTruth, runGroundTruthCanary } from '../src/ground-truth.js';
import { compareSurface } from '../src/invariants.js';
import { renderHumanReport } from '../src/report.js';
import { CrosscheckUsageError, runCrosscheck } from '../src/run.js';
import { renderedToolFromJsonSchema } from '../src/schema.js';
import type {
  CanarySpec,
  GroundTruth,
  RenderedSurface,
  RunReport,
  TargetSpec,
} from '../src/types.js';
import { type ExecResult, execCapture, spawnManaged } from '../src/util/exec.js';
import { getFreePort, waitForReady } from '../src/util/net.js';
import { VERSION } from '../src/version.js';
import { FIXTURE_TOOLS } from './fixture-server/tools.js';

const REPO_ROOT = join(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const FIXTURE_SERVER = join(import.meta.dir, 'fixture-server', 'server.ts');
/** Pinned so version resolution short-circuits instead of calling `npm view`. */
const INSPECTOR_PIN = '2.1.0';
const TIMEOUT_MS = 30_000;

const CANARY: CanarySpec = { args: { message: 'probe' }, tool: 'echo_message' };
/** The same canary as the `--canary '<tool>={json}'` flag spells it. */
const CANARY_FLAG = `${CANARY.tool}=${JSON.stringify(CANARY.args)}`;
const STDIO_TARGET: TargetSpec = {
  args: [FIXTURE_SERVER],
  command: process.execPath,
  env: {},
  kind: 'stdio',
};

const NETWORK_LANES = process.env.CROSSCHECK_E2E_NETWORK === '1';
const CODEX_LANE = process.env.CROSSCHECK_E2E_CODEX === '1';
const HAS_UV = Bun.which('uv') !== null;

/** Bun's reporter prints a skip count but not the names, so each gate says why it is off. */
if (!NETWORK_LANES) {
  console.error('[e2e] inspector and mcpo lanes skipped — set CROSSCHECK_E2E_NETWORK=1');
} else if (!HAS_UV) {
  console.error('[e2e] mcpo lane skipped — uv is not on PATH');
}
if (!CODEX_LANE) console.error('[e2e] codex lane skipped — set CROSSCHECK_E2E_CODEX=1');

function runCli(args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  return execCapture(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, timeoutMs });
}

/** The verbatim rendering a faithful client produces — the zero-divergence baseline. */
function verbatimSurface(groundTruth: GroundTruth): RenderedSurface {
  return {
    tools: groundTruth.tools.map((tool) =>
      renderedToolFromJsonSchema(tool.name, tool.description, tool.inputSchema),
    ),
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
    expect(groundTruth.tools).toEqual(
      FIXTURE_TOOLS.map((tool) => ({
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
        name: tool.name,
      })),
    );
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
    expect(groundTruth.tools).toEqual(
      FIXTURE_TOOLS.map((tool) => ({
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
        name: tool.name,
      })),
    );
  });

  test('the canary round-trips over http', async () => {
    expect(await runGroundTruthCanary(target, CANARY, TIMEOUT_MS)).toEqual({
      attempted: true,
      detail: null,
      ok: true,
    });
  });
});

describe('hermetic core: orchestration', () => {
  test('assembles a report and persists ground truth with no adapters selected', async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), 'crosscheck-e2e-'));
    try {
      const report = await runCrosscheck({
        adapters: [],
        artifactsDir,
        canary: CANARY,
        target: STDIO_TARGET,
        timeoutMs: TIMEOUT_MS,
      });
      expect(report.pass).toBe(true);
      expect(report.failCount).toBe(0);
      expect(report.crosscheckVersion).toBe(VERSION);
      expect(report.groundTruth.toolCount).toBe(6);
      expect(report.groundTruth.canary).toEqual({ attempted: true, detail: null, ok: true });
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
    } finally {
      await rm(artifactsDir, { force: true, recursive: true });
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
});

describe('CLI process lane', () => {
  test('--help exits 0 and prints the usage block', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mcp-crosscheck [flags]');
  });

  test('--version prints the package version', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  const USAGE_ERRORS: { args: string[]; name: string }[] = [
    { args: [], name: 'no target at all' },
    { args: ['--adapters', 'nope', '--', 'node', 'server.js'], name: 'an unknown adapter name' },
    { args: ['--canary', 'malformed', '--', 'node', 'server.js'], name: 'a canary without `=`' },
    {
      args: ['--canary', 'echo_message=[1,2]', '--', 'node', 'server.js'],
      name: 'canary args that are not a JSON object',
    },
    {
      args: ['--http', 'http://127.0.0.1:1/mcp', '--', 'node', 'server.js'],
      name: '--http alongside a stdio command',
    },
    { args: ['--timeout', '0', '--', 'node', 'server.js'], name: 'a non-positive --timeout' },
  ];

  for (const scenario of USAGE_ERRORS) {
    test(`exits 2 on ${scenario.name}`, async () => {
      const result = await runCli(scenario.args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('mcp-crosscheck:');
    });
  }

  test('exits 2 when the canary names a tool the server never advertised', async () => {
    const result = await runCli(['--canary', 'nope={}', '--', process.execPath, FIXTURE_SERVER]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not advertised by the server');
  });
});

describe.skipIf(!NETWORK_LANES)('inspector lane', () => {
  test('renders every fixture tool verbatim and round-trips the canary', async () => {
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
        FIXTURE_SERVER,
      ],
      300_000,
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as RunReport;
    expect(report.pass).toBe(true);
    const [inspector] = report.adapters;
    expect(inspector?.adapter).toBe('inspector');
    expect(inspector?.status).toBe('ok');
    expect(inspector?.resolvedVersion).toBe(INSPECTOR_PIN);
    expect(inspector?.toolCount).toBe(6);
    expect(inspector?.canary?.ok).toBe(true);
    expect(inspector?.findings).toEqual([]);
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
});
