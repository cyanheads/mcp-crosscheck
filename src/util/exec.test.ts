/**
 * @file src/util/exec.test.ts
 * Tests for the process helpers: output compression (findings and status
 * details must stay one bounded line, whatever a child prints), the timeout
 * path that feeds `handshake-failure` classification, process-group teardown
 * of descendants that outlive their leader, and UTF-8 decoding across pipe
 * chunks. Windows paths run through the platform-parameterized seam only.
 */
import { describe, expect, test } from 'bun:test';
import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  createNodeExec,
  excerpt,
  execCapture,
  killTree,
  nodeExec,
  resolveSpawnCommand,
  spawnManaged,
} from './exec.js';
import { npmLatestVersion } from './versions.js';

/** The shape mcpo fails with when a fresh `uvx` resolve pulls an incompatible dependency. */
const PYTHON_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/Users/x/.cache/uv/environments-v2/mcpo/bin/mcpo", line 5, in <module>',
  '    from mcpo.main import app',
  '  File "/Users/x/.cache/uv/environments-v2/mcpo/lib/python3.13/site-packages/mcpo/main.py", line 9',
  '    from mcp.client.streamable_http import streamablehttp_client',
  'ImportError: cannot import name streamablehttp_client',
].join('\n');

const RICH_TRACEBACK = [
  'Resolving packages '.repeat(16),
  '╭──────────────────── Traceback (most recent call last) ────────────────────╮',
  '│ /tmp/mcpo/bin/mcpo:5 in <module>                                         │',
  '│                                                                          │',
  '│   from mcpo.main import app                                              │',
  '╰──────────────────────────────────────────────────────────────────────────╯',
  'ImportError: cannot import name streamablehttp_client',
].join('\n');

describe('excerpt', () => {
  test('flattens a multi-line traceback into one line', () => {
    const line = excerpt(PYTHON_TRACEBACK);
    expect(line).not.toContain('\n');
    expect(line).toContain('Traceback (most recent call last):');
    expect(line).toContain('ImportError: cannot import name streamablehttp_client');
  });

  test('anchors an overflowing boxed traceback at its terminal error', () => {
    const line = excerpt(RICH_TRACEBACK, 150);
    expect(line).not.toContain('\n');
    expect(line.startsWith('…')).toBe(true);
    expect(line).toContain('from mcpo.main import app');
    expect(line).toContain('ImportError: cannot import name streamablehttp_client');
    expect(line.length).toBeLessThanOrEqual(151);
  });

  test('collapses whitespace runs and trims the edges', () => {
    expect(excerpt('  spread   \n\t over  lines \n')).toBe('spread over lines');
  });

  test('removes blank and decoration-only box-drawing lines', () => {
    expect(excerpt(' before \n\n  ├─────┤  \n\t after ')).toBe('before after');
  });

  test('returns an empty excerpt when normalization removes every line', () => {
    expect(excerpt('\n ───── \n\t')).toBe('');
  });

  test('does not add an ellipsis when normalized content exactly meets the budget', () => {
    expect(excerpt('12345', 5)).toBe('12345');
  });

  test('keeps the existing head selection when no error-shaped line is present', () => {
    expect(excerpt('package runner preamble\nstill resolving dependencies', 24)).toBe(
      'package runner preamble …',
    );
  });

  test('does not promote warnings to error-tail selection', () => {
    expect(
      excerpt(`npm WARN failed optional dependency\n${'ordinary chatter '.repeat(8)}`, 32),
    ).toBe('npm WARN failed optional depende…');
  });

  test('recognizes each canonical error-shaped form case-insensitively', () => {
    for (const errorLine of [
      'error: terminal',
      'EXCEPTION: terminal',
      'Traceback: terminal',
      'ImportError: terminal',
      'ModuleNotFoundError: terminal',
      'Cannot load terminal',
      'FAILED to load terminal',
      'npm ERR! code E404 terminal',
    ]) {
      const line = excerpt(`${'install chatter '.repeat(8)}\n${errorLine}`, 32);
      expect(line.startsWith('…')).toBe(true);
      expect(line.endsWith(errorLine)).toBe(true);
      expect(line.length).toBeLessThanOrEqual(33);
    }
  });

  test('anchors at the last error-shaped source line', () => {
    const line = excerpt(
      `Error: first failure\n${'intervening context '.repeat(5)}\nFailed: terminal failure`,
      40,
    );
    expect(line).toBe('…rvening context Failed: terminal failure');
  });

  test('keeps the end of an error line longer than the content budget', () => {
    const line = excerpt(`Error: ${'x'.repeat(80)}terminal`, 24);
    expect(line).toBe(`…${'x'.repeat(16)}terminal`);
    expect(line.length).toBe(25);
  });

  test('uses a suffix marker when only output after the error is omitted', () => {
    expect(excerpt(`Error: terminal\n${'footer '.repeat(20)}`, 24)).toBe('Error: terminal…');
  });

  test('marks both omitted sides without losing the error behind a long footer', () => {
    const line = excerpt(
      `${'install chatter '.repeat(10)}\nError: terminal failure\n${'footer noise '.repeat(20)}`,
      24,
    );
    expect(line).toBe('…Error: terminal failure…');
    expect(line.length).toBe(25);
  });

  test('uses one marker for a zero content budget and rejects invalid budgets', () => {
    expect(excerpt('omitted', 0)).toBe('…');
    expect(() => excerpt('invalid', -1)).toThrow(RangeError);
    expect(() => excerpt('invalid', 1.5)).toThrow(RangeError);
  });
});

describe('execCapture', () => {
  test.skipIf(process.platform === 'win32')(
    'preserves POSIX command arguments byte-for-byte',
    async () => {
      const tokens = ['space value', '"quoted"', '&', '|', '<', '>', '^', '%PATH%', '!bang!'];
      const result = await execCapture(
        process.execPath,
        ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...tokens],
        { timeoutMs: 30_000 },
      );
      expect(JSON.parse(result.stdout)).toEqual(tokens);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'kills the detached POSIX process group before considering the direct child',
    () => {
      const calls: [number, NodeJS.Signals][] = [];
      let directKills = 0;
      killTree(
        {
          exitCode: null,
          kill: () => {
            directKills += 1;
            return true;
          },
          pid: 4321,
          signalCode: null,
        } as ChildProcess,
        {
          kill: ((pid: number, signal: NodeJS.Signals) => {
            calls.push([pid, signal]);
            return true;
          }) as typeof process.kill,
          platform: 'linux',
        },
      );
      expect(calls).toEqual([[-4321, 'SIGKILL']]);
      expect(directKills).toBe(0);
    },
  );

  test('inherits the parent environment by default and supports an explicit clean one', async () => {
    const printPath = 'console.log(JSON.stringify({ PATH: process.env.PATH }))';
    const inherited = await execCapture(process.execPath, ['-e', printPath], {
      timeoutMs: 30_000,
    });
    expect(JSON.parse(inherited.stdout)).toEqual({ PATH: process.env.PATH });

    const clean = await execCapture(process.execPath, ['-e', printPath], {
      inheritEnv: false,
      timeoutMs: 30_000,
    });
    expect(JSON.parse(clean.stdout)).toEqual({});

    const managed = nodeExec.spawn(process.execPath, ['-e', printPath], {
      inheritEnv: false,
    });
    await managed.exited;
    expect(JSON.parse(managed.stdoutTail())).toEqual({});
  });

  test('captures stdout and the exit code', async () => {
    const result = await execCapture(process.execPath, ['-e', 'console.log("captured")'], {
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('captured');
    expect(result.timedOut).toBe(false);
  });

  test('kills a child that overruns its budget and reports timedOut', async () => {
    const result = await execCapture(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      timeoutMs: 250,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  test('reports the errno of a command that never started', async () => {
    const result = await execCapture('crosscheck-no-such-command', [], {
      env: { PATH: import.meta.dir },
      inheritEnv: false,
      timeoutMs: 30_000,
    });
    expect(result.spawnErrorCode).toBe('ENOENT');
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});

/** Every character here is multibyte in UTF-8 except the ASCII ones, and the emoji is a surrogate pair. */
const MULTIBYTE = 'café — 😀 ✓';

/** A child that writes `MULTIBYTE` to stdout and stderr one byte per write, so every character straddles reads. */
const BYTE_AT_A_TIME = `
const bytes = [...Buffer.from(${JSON.stringify(MULTIBYTE)}, 'utf8')];
let index = 0;
const timer = setInterval(() => {
  const byte = Buffer.from([bytes[index]]);
  process.stdout.write(byte);
  process.stderr.write(byte);
  index += 1;
  if (index === bytes.length) clearInterval(timer);
}, 5);
`;

describe('UTF-8 output across pipe chunks', () => {
  test('capture decodes characters split across reads', async () => {
    const result = await execCapture(process.execPath, ['-e', BYTE_AT_A_TIME], {
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(MULTIBYTE);
    expect(result.stderr).toBe(MULTIBYTE);
  });

  test('managed tails decode characters split across reads', async () => {
    const managed = spawnManaged(process.execPath, ['-e', BYTE_AT_A_TIME], {});
    expect((await managed.exited).code).toBe(0);
    expect(managed.stdoutTail()).toBe(MULTIBYTE);
    expect(managed.stderrTail()).toBe(MULTIBYTE);
  });

  test('a managed tail never opens on the second half of a surrogate pair', async () => {
    const child = fakeChild(1357);
    const managed = createNodeExec({
      kill: () => true,
      platform: 'linux',
      spawn: () => child,
    }).spawn('client', [], {});
    // 32,768 emoji plus one ASCII unit is 65,537 UTF-16 units: a 64 KiB cut lands mid-pair.
    exitAfterWriting(child, 'stderr', Buffer.from(`${'😀'.repeat(32_768)}!`, 'utf8'));
    await managed.exited;

    const tail = managed.stderrTail();
    expect(tail.length).toBe(64 * 1024 - 1);
    expect(tail.codePointAt(0)).toBe(0x1f600);
    expect(tail.endsWith('😀!')).toBe(true);
  });
});

/** Whether `pid` still names a live process; zombies count until their new parent reaps them. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone, allowing time for the orphan's new parent to reap it. */
async function diesWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * A leader that starts one grandchild sharing its stdio and prints the
 * grandchild's PID. The grandchild lives 30s on its own, so a teardown that
 * misses it cannot leak it for longer. `detached` moves the grandchild out of
 * the leader's process group; `leaderIdles` keeps the leader running too.
 */
function leaderScript(opts: { detached?: boolean; leaderIdles?: boolean } = {}): string {
  return `
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  detached: ${opts.detached === true},
  stdio: 'inherit',
});
grandchild.unref();
process.stdout.write(grandchild.pid + '\\n');
${opts.leaderIdles === true ? 'setInterval(() => {}, 1000);' : ''}
`;
}

/** The grandchild PID the leader printed, killed by exact PID if a test fails before it dies. */
async function withGrandchild(
  stdout: () => string,
  body: (pid: number) => Promise<void>,
): Promise<void> {
  let pid: number | null = null;
  try {
    const printed = Number.parseInt(stdout(), 10);
    expect(Number.isSafeInteger(printed)).toBe(true);
    pid = printed;
    await body(printed);
  } finally {
    if (pid !== null && isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
}

describe.skipIf(process.platform === 'win32')('POSIX process-group teardown', () => {
  test(
    'a timeout kills every member of the group, not only the leader',
    async () => {
      const result = await execCapture(
        process.execPath,
        ['-e', leaderScript({ leaderIdles: true })],
        { timeoutMs: 1_000 },
      );
      await withGrandchild(
        () => result.stdout,
        async (pid) => {
          expect(result.timedOut).toBe(true);
          expect(await diesWithin(pid, 2_000)).toBe(true);
        },
      );
    },
    { timeout: 20_000 },
  );

  test(
    'capture returns when the leader exits and kills the descendant holding its pipes',
    async () => {
      const started = Date.now();
      const result = await execCapture(process.execPath, ['-e', leaderScript()], {
        timeoutMs: 10_000,
      });
      const elapsed = Date.now() - started;
      await withGrandchild(
        () => result.stdout,
        async (pid) => {
          expect(result).toMatchObject({ code: 0, signal: null, timedOut: false });
          expect(elapsed).toBeLessThan(5_000);
          expect(await diesWithin(pid, 2_000)).toBe(true);
        },
      );
    },
    { timeout: 20_000 },
  );

  test(
    'a managed leader exit settles exited and kills the descendant holding its pipes',
    async () => {
      const started = Date.now();
      const managed = spawnManaged(process.execPath, ['-e', leaderScript()], {});
      const exit = await managed.exited;
      const elapsed = Date.now() - started;
      await withGrandchild(managed.stdoutTail, async (pid) => {
        expect(exit).toEqual({ code: 0, signal: null });
        expect(managed.hasExited()).toBe(true);
        expect(elapsed).toBeLessThan(5_000);
        expect(await diesWithin(pid, 2_000)).toBe(true);
        expect(() => managed.kill()).not.toThrow();
      });
    },
    { timeout: 20_000 },
  );

  test(
    'capture cuts the pipes of a descendant that left the group, within the drain grace',
    async () => {
      const started = Date.now();
      const result = await execCapture(process.execPath, ['-e', leaderScript({ detached: true })], {
        timeoutMs: 10_000,
      });
      const elapsed = Date.now() - started;
      await withGrandchild(
        () => result.stdout,
        async (pid) => {
          expect(result).toMatchObject({ code: 0, signal: null, timedOut: false });
          expect(elapsed).toBeLessThan(5_000);
          // Outside the group, the grandchild is beyond teardown's reach; withGrandchild kills it.
          expect(isAlive(pid)).toBe(true);
        },
      );
    },
    { timeout: 20_000 },
  );
});

interface FakeChild extends ChildProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function fakeChild(pid: number | undefined): FakeChild {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    kill: () => true,
    pid,
    signalCode: null,
    stderr: new PassThrough(),
    stdout: new PassThrough(),
  }) as unknown as FakeChild;
}

/** Write `data` to one fake pipe, exit 0, and close once the consumer has read to the end. */
function exitAfterWriting(
  child: FakeChild,
  stream: 'stderr' | 'stdout',
  data: string | Buffer,
): void {
  const pipe = child[stream] as PassThrough;
  pipe.once('end', () => child.emit('close', 0, null));
  pipe.end(data);
  child.exitCode = 0;
  child.emit('exit', 0, null);
}

describe('platform command construction', () => {
  const TOKENS = [
    'space value',
    '"quoted"',
    'amp&ersand',
    'pipe|value',
    'left<value',
    'right>value',
    'caret^value',
    '%PATH%',
    '!delayed!',
  ];

  test('preserves every POSIX command and token unchanged', () => {
    for (const command of ['npx', 'npm', 'uvx', 'node', 'claude', './user-server']) {
      expect(resolveSpawnCommand(command, TOKENS, 'linux', '/usr/bin/node')).toEqual({
        args: TOKENS,
        command,
      });
    }
  });

  test('runs only bare Windows npx and npm through Node while preserving metacharacter tokens', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    for (const [command, cli] of [
      ['npx', 'npx-cli.js'],
      ['npm', 'npm-cli.js'],
    ] as const) {
      expect(resolveSpawnCommand(command, TOKENS, 'win32', node)).toEqual({
        args: [`C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\${cli}`, ...TOKENS],
        command: node,
      });
    }

    for (const command of [
      'npx.cmd',
      'npm.cmd',
      'uvx',
      'bun',
      'node',
      'claude',
      'constructor',
      '.\\user-server.cmd',
    ]) {
      expect(resolveSpawnCommand(command, TOKENS, 'win32', node)).toEqual({
        args: TOKENS,
        command,
      });
    }
  });

  test('npmLatestVersion reaches npm through Node on Windows', async () => {
    const calls: { args: string[]; command: string; options: NodeSpawnOptions }[] = [];
    const npm = fakeChild(1122);
    const exec = createNodeExec({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      platform: 'win32',
      spawn: (command, args, options) => {
        calls.push({ args, command, options });
        queueMicrotask(() => exitAfterWriting(npm, 'stdout', '2.1.0\n'));
        return npm;
      },
    });

    expect(await npmLatestVersion('@modelcontextprotocol/inspector', 'C:\\work', exec)).toBe(
      '2.1.0',
    );
    expect(calls).toEqual([
      {
        args: [
          'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
          'view',
          '@modelcontextprotocol/inspector',
          'version',
        ],
        command: 'C:\\Program Files\\nodejs\\node.exe',
        options: expect.objectContaining({ cwd: 'C:\\work', detached: false, shell: false }),
      },
    ]);
  });
});

describe('platform process-tree teardown', () => {
  function windowsHarness(pid: number | undefined) {
    const target = fakeChild(pid);
    const calls: { args: string[]; command: string; options: NodeSpawnOptions }[] = [];
    let taskkillUnrefs = 0;
    const spawn = (command: string, args: string[], options: NodeSpawnOptions) => {
      calls.push({ args, command, options });
      if (command === 'taskkill.exe') {
        const taskkill = fakeChild(9999);
        taskkill.unref = () => {
          taskkillUnrefs += 1;
        };
        queueMicrotask(() => taskkill.emit('error', new Error('best-effort taskkill failure')));
        return taskkill;
      }
      return target;
    };
    return {
      calls,
      exec: createNodeExec({
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        platform: 'win32',
        spawn,
      }),
      taskkillUnrefs: () => taskkillUnrefs,
      target,
    };
  }

  test('execCapture timeout selects taskkill for the live Windows PID tree', async () => {
    const harness = windowsHarness(4321);
    const resultPromise = harness.exec.capture('node', ['server.js'], { timeoutMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.target.signalCode = 'SIGKILL';
    harness.target.emit('close', null, 'SIGKILL');
    expect((await resultPromise).timedOut).toBe(true);
    expect(harness.calls[1]).toEqual({
      args: ['/PID', '4321', '/T', '/F'],
      command: 'taskkill.exe',
      options: {
        detached: false,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    });
    expect(harness.taskkillUnrefs()).toBe(1);
  });

  test('Windows npx resolution preserves an explicitly clean environment', async () => {
    const harness = windowsHarness(2468);
    const managed = harness.exec.spawn('npx', ['--version'], {
      env: { PATH: 'C:\\fixture-bin' },
      inheritEnv: false,
    });
    harness.target.exitCode = 0;
    harness.target.emit('close', 0, null);
    await managed.exited;

    expect(harness.calls).toEqual([
      {
        args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', '--version'],
        command: 'C:\\Program Files\\nodejs\\node.exe',
        options: {
          detached: false,
          env: { PATH: 'C:\\fixture-bin' },
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      },
    ]);
  });

  test('managed kill selects the same taskkill path', () => {
    const harness = windowsHarness(7654);
    harness.exec.spawn('node', ['server.js'], {}).kill();
    expect(harness.calls[1]).toEqual({
      args: ['/PID', '7654', '/T', '/F'],
      command: 'taskkill.exe',
      options: {
        detached: false,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    });
    expect(harness.taskkillUnrefs()).toBe(1);
  });

  test('Windows tree kill skips PID-less and already-exited children', () => {
    for (const child of [fakeChild(undefined), fakeChild(1234)]) {
      const calls: string[] = [];
      if (child.pid !== undefined) child.exitCode = 0;
      killTree(child, {
        platform: 'win32',
        spawn: (command) => {
          calls.push(command);
          return fakeChild(9999);
        },
      });
      expect(calls).toEqual([]);
    }
  });

  test('Windows tree kill ignores a synchronous taskkill launch failure', () => {
    expect(() =>
      killTree(fakeChild(1234), {
        platform: 'win32',
        spawn: () => {
          throw new Error('taskkill unavailable');
        },
      }),
    ).not.toThrow();
  });

  test('a POSIX leader exit sweeps its group once, and a later kill signals nothing', async () => {
    const signals: [number, NodeJS.Signals][] = [];
    const leader = fakeChild(4321);
    const managed = createNodeExec({
      kill: ((pid: number, signal: NodeJS.Signals) => {
        signals.push([pid, signal]);
        return true;
      }) as typeof process.kill,
      platform: 'linux',
      spawn: () => leader,
    }).spawn('npx', ['client'], {});

    exitAfterWriting(leader, 'stderr', 'client output');
    expect(signals).toEqual([[-4321, 'SIGKILL']]);
    await managed.exited;
    managed.kill();
    expect(signals).toEqual([[-4321, 'SIGKILL']]);
    expect(managed.stderrTail()).toBe('client output');
  });

  /** A leader that exits while its pipes stay open, as when an unreachable descendant holds them. */
  function pipesOutliveLeader(platform: NodeJS.Platform) {
    const signals: number[] = [];
    const spawned: string[] = [];
    const leader = fakeChild(5555);
    const exec = createNodeExec({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      kill: ((pid: number) => {
        signals.push(pid);
        return true;
      }) as typeof process.kill,
      platform,
      spawn: (command) => {
        spawned.push(command);
        return leader;
      },
    });
    const exitLeavingPipesOpen = () => {
      (leader.stdout as PassThrough).write('partial output');
      leader.exitCode = 0;
      leader.emit('exit', 0, null);
    };
    return { exec, exitLeavingPipesOpen, leader, signals, spawned };
  }

  for (const platform of ['linux', 'win32'] as const) {
    test(`${platform}: capture cuts pipes that outlive the leader after the drain grace`, async () => {
      const harness = pipesOutliveLeader(platform);
      const started = Date.now();
      const pending = harness.exec.capture('client', [], { timeoutMs: 50 });
      harness.exitLeavingPipesOpen();
      const result = await pending;

      // The leader exited inside its budget, so the drain wait is not a timeout.
      expect(result).toEqual({
        code: 0,
        signal: null,
        stderr: '',
        stdout: 'partial output',
        timedOut: false,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(harness.leader.stdout?.destroyed).toBe(true);
      expect(harness.leader.stderr?.destroyed).toBe(true);
      expect(harness.spawned).toEqual(['client']);
      expect(harness.signals).toEqual(platform === 'win32' ? [] : [-5555]);
    });

    test(`${platform}: managed exited settles after the drain grace and a later kill is inert`, async () => {
      const harness = pipesOutliveLeader(platform);
      const managed = harness.exec.spawn('client', [], {});
      harness.exitLeavingPipesOpen();

      expect(await managed.exited).toEqual({ code: 0, signal: null });
      expect(managed.hasExited()).toBe(true);
      expect(managed.stdoutTail()).toBe('partial output');
      managed.kill();
      expect(harness.spawned).toEqual(['client']);
      expect(harness.signals).toEqual(platform === 'win32' ? [] : [-5555]);
    });
  }
});
