/**
 * @file src/util/exec.test.ts
 * Tests for the process helpers: output compression (findings and status
 * details must stay one bounded line, whatever a child prints) and the timeout
 * path that feeds `handshake-failure` classification.
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
} from './exec.js';

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
    for (const command of ['npx', 'uvx', 'node', 'claude', './user-server']) {
      expect(resolveSpawnCommand(command, TOKENS, 'linux', '/usr/bin/node')).toEqual({
        args: TOKENS,
        command,
      });
    }
  });

  test('runs only bare Windows npx through Node while preserving metacharacter tokens', () => {
    expect(
      resolveSpawnCommand('npx', TOKENS, 'win32', 'C:\\Program Files\\nodejs\\node.exe'),
    ).toEqual({
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', ...TOKENS],
      command: 'C:\\Program Files\\nodejs\\node.exe',
    });

    for (const command of ['npx.cmd', 'uvx', 'bun', 'node', 'claude', '.\\user-server.cmd']) {
      expect(
        resolveSpawnCommand(command, TOKENS, 'win32', 'C:\\Program Files\\nodejs\\node.exe'),
      ).toEqual({ args: TOKENS, command });
    }
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
});
