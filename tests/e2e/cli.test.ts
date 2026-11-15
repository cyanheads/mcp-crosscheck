/**
 * @file tests/e2e/cli.test.ts
 * CLI process lane: the real CLI as a subprocess — help, version, usage exit
 * codes, and flag handling against the fixture server. No network. Run:
 * `bun test tests/e2e/cli.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ErrorReport, RunReport } from '../../src/types.js';
import { spawnManaged } from '../../src/util/exec.js';
import { getFreePort, waitForReady } from '../../src/util/net.js';
import { VERSION } from '../../src/version.js';
import {
  CANARY_FLAG,
  canonicalEnvNames,
  FIXTURE_SERVER,
  launchProbes,
  NESTED_CANARY,
  REPO_ROOT,
  runCli,
  TIMEOUT_MS,
  UNREACHABLE_URL,
} from './harness.js';

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
  const BLANK_PIN = (name: string) =>
    `pin for adapter "${name}" must be a non-blank version string`;
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
    // `codex=` with the default adapters: a pin is checked whether or not its adapter runs.
    ...['inspector=', 'inspector=  ', 'codex='].map((pin) => ({
      args: ['--pin', pin, ...STDIO],
      message: BLANK_PIN(pin.slice(0, pin.indexOf('='))),
      name: `the blank pin ${JSON.stringify(pin)}`,
    })),
    {
      args: ['--pin', 'inspector=2.8.0', '--pin', 'inspector=2.15.0', ...STDIO],
      message: '--pin names adapter "inspector" more than once',
      name: 'two pins for one adapter',
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

  test('a variable exported in the invoking shell reaches the target only when passed with --env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-cli-probe-'));
    const probePath = join(dir, 'probe.jsonl');
    // An empty PATH makes the installed-client lookup fail once ground truth is done.
    const emptyPath = join(dir, 'empty-path');
    await mkdir(emptyPath);
    try {
      const result = await runCli(
        [
          '--json',
          '--adapters',
          'claude-code',
          '--canary',
          CANARY_FLAG,
          '--env',
          `MCP_FIXTURE_PROBE_PATH=${probePath}`,
          '--env',
          'CROSSCHECK_PASSED=yes',
          // An empty value is a value, not a usage error.
          '--env',
          'CROSSCHECK_EMPTY=',
          '--',
          process.execPath,
          // A bare relative path, resolved from the directory the CLI runs in.
          'tests/fixture-server/server.ts',
          '--flag',
          'x',
        ],
        60_000,
        { CROSSCHECK_SHELL_ONLY: 'exported', PATH: emptyPath },
      );
      const report = JSON.parse(result.stdout) as RunReport;
      expect([report.groundTruth.toolCount, report.groundTruth.canary?.ok]).toEqual([6, true]);
      expect(report.adapters.map((adapter) => adapter.status)).toEqual(['adapter-broken']);
      // Ground truth, then the ground-truth canary.
      expect(await launchProbes(probePath)).toEqual(
        Array.from({ length: 2 }, () => ({
          argv: ['--flag', 'x'],
          cwd: REPO_ROOT,
          envNames: canonicalEnvNames(
            { CROSSCHECK_EMPTY: '', CROSSCHECK_PASSED: 'yes', MCP_FIXTURE_PROBE_PATH: probePath },
            ['PATH'],
          ),
          home: process.env.HOME ?? null,
        })),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
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
        // A string flag missing its value right before --json.
        ['--timeout', '--json', ...STDIO],
        ['--baseline', '--json', ...STDIO],
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
