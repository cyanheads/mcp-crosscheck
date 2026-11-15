/**
 * @file tests/e2e/claude-code.test.ts
 * claude-code lane. The orchestration block runs `runCrosscheck` against the
 * fixture server with a fake installed `claude` posting to the adapter's real
 * intercept, in the default suite. The gated block runs the installed Claude
 * Code executable against the fixture server through the isolated base-URL
 * intercept, on CROSSCHECK_E2E_CLAUDE_CODE=1. Run:
 * `CROSSCHECK_E2E_CLAUDE_CODE=1 bun test tests/e2e/claude-code.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCrosscheck } from '../../src/run.js';
import type { RunReport, TargetSpec } from '../../src/types.js';
import type { Exec } from '../../src/util/exec.js';
import { fakeClaudeCodeClient } from '../helpers/fake-clients.js';
import { captureExec, managed } from '../helpers/fake-exec.js';
import {
  canonicalEnvNames,
  FIXTURE_SERVER,
  launchProbes,
  REPO_ROOT,
  runCli,
  TIMEOUT_MS,
} from './harness.js';

const CLAUDE_CODE_LANE = process.env.CROSSCHECK_E2E_CLAUDE_CODE === '1';
/** What Claude Code always sends, whatever the server: its own built-in tools. */
const BUILT_INS = [
  { input_schema: { type: 'object' }, name: 'Bash' },
  { input_schema: { type: 'object' }, name: 'ListMcpResourcesTool' },
];
const NO_MCP_TOOLS =
  'tools-bearing model request captured but it carried no MCP tools for the configured target';

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
/** Claude Code's entries for minimal tools it sends as `names`. */
const prefixed = (names: string[]) =>
  names.map((name) => ({ input_schema: { type: 'object' }, name: `mcp__target__${name}` }));

/** An installed `claude` reporting a version, whose launch is `spawn`. */
const installed = (spawn: Exec['spawn']): Exec => ({
  capture: captureExec({ stdout: '2.1.325 (Claude Code)\n' }).capture,
  spawn,
});

function runClaudeCode(target: TargetSpec, exec: Exec, timeoutMs = TIMEOUT_MS): Promise<RunReport> {
  return runCrosscheck({ adapters: ['claude-code'], exec, target, timeoutMs });
}

if (!CLAUDE_CODE_LANE) {
  console.error('[e2e] claude-code lane skipped — set CROSSCHECK_E2E_CLAUDE_CODE=1');
}

describe('claude-code orchestration', () => {
  test('a capture with no MCP tools passes against a server that advertises none', async () => {
    const fake = fakeClaudeCodeClient([{ tools: BUILT_INS }]);
    const report = await runClaudeCode(fixtureAdvertising([]), installed(fake.spawn));
    const [claudeCode] = report.adapters;
    expect([report.pass, report.failCount, report.groundTruth.toolCount]).toEqual([true, 0, 0]);
    expect([
      claudeCode?.status,
      claudeCode?.statusDetail,
      claudeCode?.toolCount,
      claudeCode?.findings,
    ]).toEqual(['ok', null, 0, []]);
  });

  test('the same capture against a server that advertises tools is a handshake-failure', async () => {
    const fake = fakeClaudeCodeClient([{ tools: BUILT_INS }]);
    const report = await runClaudeCode(
      { args: [FIXTURE_SERVER], command: process.execPath, env: {}, kind: 'stdio' },
      installed(fake.spawn),
    );
    const [claudeCode] = report.adapters;
    expect(report.pass).toBe(false);
    expect([
      claudeCode?.status,
      claudeCode?.statusDetail,
      claudeCode?.toolCount,
      claudeCode?.canary,
    ]).toEqual(['handshake-failure', NO_MCP_TOOLS, null, null]);
    expect(claudeCode?.findings).toEqual([
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
    const exited = await runClaudeCode(
      fixtureAdvertising([]),
      installed(() => managed({ exited: true, stderr: 'claude: startup failed' })),
    );
    expect([exited.adapters[0]?.status, exited.adapters[0]?.toolCount, exited.pass]).toEqual([
      'adapter-broken',
      null,
      false,
    ]);
    const silent = await runClaudeCode(
      fixtureAdvertising([]),
      installed(() => managed({})),
      2_000,
    );
    expect([silent.adapters[0]?.status, silent.adapters[0]?.statusDetail, silent.pass]).toEqual([
      'handshake-failure',
      'no tools-bearing model request captured within 2000ms',
      false,
    ]);
  });

  test('a renamed tool is matched under its rendered name; the loser of a collision is tool-missing', async () => {
    const advertised = ['files.read', 'files_read', 'get-weather', 'plain_tool'].map(minimal);
    // The names Claude Code 2.1.325 sends for this list.
    const fake = fakeClaudeCodeClient([
      { tools: [...BUILT_INS, ...prefixed(['files_read', 'get-weather', 'plain_tool'])] },
    ]);
    const report = await runClaudeCode(fixtureAdvertising(advertised), installed(fake.spawn));
    const [claudeCode] = report.adapters;
    expect([claudeCode?.status, claudeCode?.toolCount]).toEqual(['ok', 3]);
    expect(claudeCode?.findings).toEqual([
      {
        detail: 'tool name was sanitized in rendering — the client renders it as "files_read"',
        evidence: { change: 'sanitized', kind: 'tool-renamed' },
        path: 'files.read',
        rule: 'tool-renamed',
        severity: 'info',
      },
      {
        detail:
          'tool is missing from the rendered surface — the client drops it: "files.read", listed before it, also renders as "files_read", and Claude Code keeps only the first',
        evidence: { kind: 'tool-missing' },
        path: 'files_read',
        rule: 'tool-missing',
        severity: 'fail',
      },
    ]);
  });

  test('a server whose every tool Claude Code drops reports those drops, not a failed handshake', async () => {
    const long = 'k'.repeat(116);
    // Claude Code 2.1.325 sends no MCP tool for a name over 128 units once prefixed.
    const fake = fakeClaudeCodeClient([{ tools: BUILT_INS }]);
    const report = await runClaudeCode(fixtureAdvertising([minimal(long)]), installed(fake.spawn));
    const [claudeCode] = report.adapters;
    expect([claudeCode?.status, claudeCode?.statusDetail, claudeCode?.toolCount]).toEqual([
      'ok',
      null,
      0,
    ]);
    expect(claudeCode?.findings).toEqual([
      {
        detail: `tool is missing from the rendered surface — the client drops it: its rendered name "mcp__target__${long}" is 129 characters, and Claude Code sends none longer than 128`,
        evidence: { kind: 'tool-missing' },
        path: long,
        rule: 'tool-missing',
        severity: 'fail',
      },
    ]);
  });
});

describe.skipIf(!CLAUDE_CODE_LANE)('claude-code lane', () => {
  // Claude Code updates itself, so the lane exercises whichever release is installed.
  const installedVersion = () =>
    Bun.spawnSync(['claude', '--version']).stdout.toString().split(' ')[0];

  test('captures the converted tool surface through the isolated base-URL intercept', async () => {
    const version = installedVersion();
    console.error(`[e2e] claude-code lane exercised Claude Code ${version}`);
    const result = await runCli(
      ['--adapters', 'claude-code', '--json', '--', process.execPath, FIXTURE_SERVER],
      540_000,
    );
    const report = JSON.parse(result.stdout) as RunReport;
    const [claudeCode] = report.adapters;
    expect(claudeCode?.adapter).toBe('claude-code');
    expect(claudeCode?.resolvedVersion).toBe(version);
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

  test('starts the target exactly as ground truth does, with every --env name intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-claude-code-probe-'));
    const probePath = join(dir, 'probe.jsonl');
    const passed = { 'A B': '1', 'MY.VAR': '1', MCP_FIXTURE_PROBE_PATH: probePath, 'Q"X': '1' };
    try {
      const result = await runCli(
        [
          '--adapters',
          'claude-code',
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
      // Ground truth first, then each start under Claude Code.
      expect(probes.length).toBeGreaterThanOrEqual(2);
      for (const probe of probes) {
        expect(probe).toEqual({
          argv: [],
          cwd: REPO_ROOT,
          envNames: canonicalEnvNames(passed),
          home: process.env.HOME ?? null,
        });
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 600_000);

  test('a server that advertises no tools passes', async () => {
    const result = await runCli(
      [
        '--adapters',
        'claude-code',
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
    const [claudeCode] = report.adapters;
    expect([
      result.code,
      report.pass,
      claudeCode?.status,
      claudeCode?.toolCount,
      claudeCode?.findings,
    ]).toEqual([0, true, 'ok', 0, []]);
  }, 600_000);

  test('every name Claude Code rewrites or drops is matched by the rename model', async () => {
    const long = 'b'.repeat(116);
    const names = [
      'files.read',
      'files_read',
      'get-weather',
      'plain_tool',
      'é.x',
      'claude.ai  x__',
      'a'.repeat(115),
      long,
    ];
    const result = await runCli(
      [
        '--adapters',
        'claude-code',
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
    const [claudeCode] = report.adapters;
    // files_read and the 116-character name are dropped by the client itself.
    expect([claudeCode?.status, claudeCode?.toolCount]).toEqual(['ok', names.length - 2]);
    expect(
      claudeCode?.findings.map((finding) => [
        finding.rule,
        finding.path,
        finding.evidence.kind === 'tool-renamed' ? finding.evidence.change : null,
      ]),
    ).toEqual([
      ['tool-renamed', 'files.read', 'sanitized'],
      ['tool-missing', 'files_read', null],
      ['tool-renamed', 'é.x', 'sanitized'],
      ['tool-renamed', 'claude.ai  x__', 'sanitized'],
      ['tool-missing', long, null],
    ]);
  }, 600_000);
});
