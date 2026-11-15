/**
 * @file tests/e2e/mcpo.test.ts
 * mcpo lane: the real mcpo proxy, resolved through `uv`, against the fixture
 * server. Gated on CROSSCHECK_E2E_NETWORK=1 and `uv` on PATH. Run:
 * `CROSSCHECK_E2E_NETWORK=1 bun test tests/e2e/mcpo.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCrosscheck } from '../../src/run.js';
import type { RunReport } from '../../src/types.js';
import {
  CANARY,
  CANARY_FLAG,
  canonicalEnvNames,
  FIXTURE_SERVER,
  launchProbes,
  NETWORK_LANES,
  runCli,
} from './harness.js';

const HAS_UV = Bun.which('uv') !== null;

if (NETWORK_LANES && !HAS_UV) console.error('[e2e] mcpo lane skipped — uv is not on PATH');

describe.skipIf(!NETWORK_LANES || !HAS_UV)('mcpo lane', () => {
  /**
   * The README's default run: no `--mcpo-with`, so the adapter's own default
   * constraints are what keep latest mcpo importable. The verdict belongs to
   * the converter, not the harness: mcpo drops type information the fixture
   * deliberately carries, so this asserts the classification and the rendered
   * surface rather than a pass.
   */
  test('a default run renders the fixture through the OpenAPI proxy', async () => {
    const result = await runCli(
      [
        '--adapters',
        'mcpo',
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
    expect([mcpo?.status, mcpo?.statusDetail]).toEqual(['ok', null]);
    expect(mcpo?.resolvedVersion).toMatch(/^\d+\.\d+\.\d+/);
    // Latest floats, so the lane names the release a dated measurement would cite.
    console.error(`[e2e] mcpo unpinned exercised ${mcpo?.resolvedVersion}`);
    expect(mcpo?.toolCount).toBe(6);
    expect(mcpo?.canary?.ok).toBe(true);
    const defaults = result.stderr.split('\n').filter((line) => line.includes('mcp<2'));
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toContain('fastapi<0.145');
  }, 360_000);

  /**
   * Launch parity: mcpo hands its own whole environment to the server it
   * starts, and that server is the launcher, which starts the target exactly
   * as ground truth does. One probe line per start — ground truth, its canary,
   * and the proxy's one session — each matching ground truth's launch, for a
   * bare relative target path and dash-prefixed arguments.
   */
  test('mcpo starts the target exactly as ground truth does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-mcpo-parity-'));
    const probePath = join(dir, 'probe.jsonl');
    const env = { CROSSCHECK_PASSED: 'from --env', MCP_FIXTURE_PROBE_PATH: probePath };
    try {
      const report = await runCrosscheck({
        adapters: ['mcpo'],
        canary: CANARY,
        target: {
          args: ['tests/fixture-server/server.ts', '--flag', 'x', '-e', 'y'],
          command: process.execPath,
          env,
          kind: 'stdio',
        },
        timeoutMs: 300_000,
      });
      const [mcpo] = report.adapters;
      expect([mcpo?.status, mcpo?.statusDetail]).toEqual(['ok', null]);
      expect(mcpo?.canary).toEqual({ attempted: true, detail: null, ok: true });

      const probes = await launchProbes(probePath);
      expect(probes).toEqual(
        Array.from({ length: 3 }, () => ({
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
});
