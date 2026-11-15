/**
 * @file src/launch-target.test.ts
 * The client launcher, run for real against short-lived targets: exact launch,
 * exit status, signal forwarding and re-raise, stdin teardown, orphan
 * teardown, spawn failure.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TargetLaunch } from './target.js';

const LAUNCHER = join(import.meta.dir, 'launch-target.ts');

let dir = '';
let specCount = 0;
/** Target pids a failing test could leave running; each is killed by exact pid afterwards. */
const strays: number[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crosscheck-launch-target-'));
});

afterAll(async () => {
  for (const pid of strays) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, as a passing test leaves it.
    }
  }
  await rm(dir, { force: true, recursive: true });
});

interface Launched {
  child: ChildProcess;
  /** Settles once the launcher has exited and its output is read. */
  ended: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
  }>;
  /** Settles on the first stdout output containing `text`. */
  printed(text: string): Promise<string>;
}

/** Start the launcher on a spec, itself with this process's environment plus a variable of its own. */
async function launch(spec: Partial<TargetLaunch> & Pick<TargetLaunch, 'args'>): Promise<Launched> {
  specCount += 1;
  const specPath = join(dir, `spec-${specCount}.json`);
  await writeFile(
    specPath,
    JSON.stringify({ command: process.execPath, cwd: dir, env: {}, ...spec }),
  );
  const child = spawn(process.execPath, [LAUNCHER, specPath], {
    env: { ...process.env, CROSSCHECK_LAUNCHER_ONLY: 'launcher' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const ended = once(child, 'close').then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    stderr,
    stdout,
  }));
  const printed = (text: string) =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        if (!stdout.includes(text)) return;
        child.stdout?.off('data', check);
        resolve(stdout);
      };
      child.stdout?.on('data', check);
      check();
      ended.then(() => reject(new Error(`launcher ended before printing ${text}: ${stdout}`)));
    });
  return { child, ended, printed };
}

/** A target script for `<runtime> -e`. */
function script(...lines: string[]): string[] {
  return ['-e', lines.join('\n')];
}

/** Keeps a target alive until something ends it. */
const STAY_ALIVE = 'setInterval(() => {}, 1 << 30);';

describe('launch-target', () => {
  test('starts the target with exactly the spec environment, working directory, and arguments', async () => {
    const { ended } = await launch({
      args: [
        ...script(
          'console.log(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), env: process.env }))',
        ),
        '--',
        '--flag',
        'x',
        '-e',
        'y',
        'with space',
      ],
      env: { ONLY_THIS: '1' },
    });
    const { code, stdout } = await ended;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      argv: ['--flag', 'x', '-e', 'y', 'with space'],
      cwd: await realpath(dir),
      env: { ONLY_THIS: '1' },
    });
  });

  test('exits with the target exit code', async () => {
    for (const status of [0, 7]) {
      const { ended } = await launch({ args: script(`process.exit(${status})`) });
      expect(await ended).toMatchObject({ code: status, signal: null });
    }
  });

  test('re-raises the signal that ended the target, forwarded or not', async () => {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const { ended } = await launch({ args: script(`process.kill(process.pid, '${signal}')`) });
      expect(await ended).toMatchObject({ code: null, signal });
    }
  });

  test('forwards SIGHUP, SIGINT, and SIGTERM to the target', async () => {
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
      const { child, ended, printed } = await launch({
        args: script(
          `process.on('${signal}', () => { console.log('target got ${signal}'); process.exit(0); });`,
          "console.log('ready');",
          STAY_ALIVE,
        ),
      });
      await printed('ready');
      child.kill(signal);
      const { code, stdout } = await ended;
      expect(stdout).toContain(`target got ${signal}`);
      expect(code).toBe(0);
    }
  });

  test('a client stopping the launcher stops the target and leaves no process behind', async () => {
    const { child, ended, printed } = await launch({
      args: script("console.log('pid ' + process.pid);", STAY_ALIVE),
    });
    const pid = Number((await printed('pid ')).match(/pid (\d+)/)?.[1]);
    child.kill('SIGTERM');
    expect(await ended).toMatchObject({ code: null, signal: 'SIGTERM' });
    // The launcher exits only after reaping the target, so the pid is already gone.
    let probe: unknown = null;
    try {
      process.kill(pid, 0);
    } catch (error) {
      probe = error;
    }
    expect(probe).toMatchObject({ code: 'ESRCH' });
  });

  test.skipIf(process.platform === 'win32')(
    'a client killed outright, with the launcher in a process group of its own, still leaves no target behind',
    async () => {
      specCount += 1;
      const specPath = join(dir, `spec-${specCount}.json`);
      // The target ignores stdin EOF, so only the launcher can end it.
      await writeFile(
        specPath,
        JSON.stringify({
          args: script("console.log('pid ' + process.pid);", STAY_ALIVE),
          command: process.execPath,
          cwd: dir,
          env: {},
        }),
      );
      // A client that starts the launcher in a new session, as Python `mcp` does, and is then SIGKILLed.
      const client = spawn(
        process.execPath,
        script(
          `require('node:child_process').spawn(process.execPath, ${JSON.stringify([LAUNCHER, specPath])}, { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
          STAY_ALIVE,
        ),
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let stdout = '';
      // The pipe closes only once the client, the launcher, and the target have all let go of it.
      const closed = once(client.stdout as NodeJS.ReadableStream, 'close');
      const pid = await new Promise<number>((resolve) => {
        client.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
          const match = stdout.match(/pid (\d+)/);
          if (match !== null) resolve(Number(match[1]));
        });
      });
      strays.push(pid);
      client.kill('SIGKILL');
      await closed;
      let probe: unknown = null;
      try {
        process.kill(pid, 0);
      } catch (error) {
        probe = error;
      }
      expect(probe).toMatchObject({ code: 'ESRCH' });
    },
  );

  test('the target reads the client stdin directly, so closing it ends the target', async () => {
    const { child, ended, printed } = await launch({
      args: script(
        "process.stdin.on('end', () => process.exit(3));",
        'process.stdin.resume();',
        "console.log('ready');",
      ),
    });
    await printed('ready');
    child.stdin?.end();
    expect(await ended).toMatchObject({ code: 3, signal: null });
  });

  test('a target that cannot start is one stderr line naming the command, and exit 127', async () => {
    const command = join(dir, 'no-such-server');
    const { ended } = await launch({ args: ['--stdio'], command });
    const { code, stderr, stdout } = await ended;
    expect(code).toBe(127);
    expect(stdout).toBe('');
    const lines = stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(command);
    expect(lines[0]).toContain('ENOENT');
  });
});
