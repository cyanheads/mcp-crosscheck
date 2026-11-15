/**
 * @file tests/helpers/fake-exec.ts
 * Adapter test harness: an `AdapterContext` factory over a per-file scratch
 * directory, plus `Exec` fakes that script child-process results so no test has
 * to break a real upstream. Only child-process spawning is faked; the intercept
 * servers and readiness polling inside the adapters stay real.
 */
import { afterAll, beforeAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterContext } from '../../src/types.js';
import type { Exec, ExecOptions, ExecResult, ManagedProcess } from '../../src/util/exec.js';

export interface AdapterHarness {
  context(exec: Exec, overrides?: Partial<AdapterContext>): AdapterContext;
  /** The calling file's scratch directory; set once its `beforeAll` has run. */
  workDir(): string;
}

/** Registers a scratch directory for the calling test file and returns a context factory over it. */
export function adapterHarness(prefix: string): AdapterHarness {
  let workDir = '';
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), prefix));
  });
  afterAll(async () => {
    await rm(workDir, { force: true, recursive: true });
  });
  return {
    context: (exec, overrides = {}) => ({
      artifactsDir: null,
      canary: null,
      exec,
      log: () => {},
      mcpoWith: [],
      // Pinning short-circuits version resolution, so no test reaches a registry.
      pins: {
        'claude-code': '2.1.231',
        codex: '0.147.0-alpha.6.5',
        inspector: '2.1.0',
        mcpo: '0.0.20',
      },
      redact: (text) => text,
      target: { args: ['server.js'], command: 'node', env: {}, kind: 'stdio' },
      timeoutMs: 5_000,
      workDir,
      ...overrides,
    }),
    workDir: () => workDir,
  };
}

export const EXEC_DEFAULT: ExecResult = {
  code: 0,
  signal: null,
  stderr: '',
  stdout: '',
  timedOut: false,
};
const NEVER_EXITS = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});
const INSTALL_PREAMBLE = Array.from(
  { length: 30 },
  (_, index) => `resolving package dependency ${index}`,
).join('\n');
/** An npm install failure behind 30 lines of resolver noise the detail excerpt must skip. */
export const NPM_INSTALL_FAILURE = `${INSTALL_PREAMBLE}\nnpm ERR! code E404\nnpm ERR! package not found`;
/** A rich-rendered Python traceback behind the same noise, as `uvx mcpo` prints one. */
export const RICH_IMPORT_FAILURE = [
  INSTALL_PREAMBLE,
  '╭──────────────────── Traceback (most recent call last) ────────────────────╮',
  '│ /tmp/mcpo/bin/mcpo:5 in <module>                                         │',
  '│                                                                          │',
  '│   from mcpo.main import app                                              │',
  '╰──────────────────────────────────────────────────────────────────────────╯',
  'ImportError: cannot import name streamablehttp_client',
].join('\n');

/**
 * A managed-process stub. `exited` settles only when the scenario says the child
 * died, with exit code 1, or as a command that never started when
 * `spawnErrorCode` is set (which implies `exited`).
 */
export function managed(opts: {
  exited?: boolean;
  onKill?: () => void;
  spawnErrorCode?: string;
  stderr?: string;
}): ManagedProcess {
  const exited = opts.exited === true || opts.spawnErrorCode !== undefined;
  return {
    exited: !exited
      ? NEVER_EXITS
      : Promise.resolve(
          opts.spawnErrorCode === undefined
            ? { code: 1, signal: null }
            : { code: null, signal: null, spawnErrorCode: opts.spawnErrorCode },
        ),
    hasExited: () => exited,
    kill: () => opts.onKill?.(),
    stderrTail: () => opts.stderr ?? '',
    stdoutTail: () => '',
  };
}

/** An `Exec` whose `capture` replays a script (the last entry repeats) and never spawns. */
export function captureExec(...script: Partial<ExecResult>[]): Exec {
  let index = 0;
  return {
    capture: () => {
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      return Promise.resolve({ ...EXEC_DEFAULT, ...step });
    },
    spawn: () => {
      throw new Error('this adapter should not have spawned a managed process');
    },
  };
}

/** `captureExec`, with every command's argv appended to `calls` for flag assertions. */
export function recordingExec(calls: string[][], ...script: Partial<ExecResult>[]): Exec {
  const inner = captureExec(...script);
  return {
    capture: (command, args, opts) => {
      calls.push(args);
      return inner.capture(command, args, opts);
    },
    spawn: inner.spawn,
  };
}

/** An `Exec` that only spawns — used where the adapter's version is pinned. */
export function spawnExec(spawn: Exec['spawn']): Exec {
  return {
    capture: () => {
      throw new Error('this adapter should not have captured a command');
    },
    spawn,
  };
}

/** One `capture` call an exec fake answered. */
export interface CaptureCall {
  args: string[];
  command: string;
  options: ExecOptions;
}

/**
 * Codex's package-runner seam: `npm view` answers `registry`, `npx … --version`
 * answers `prime`, and `npm config get cache` answers `cache`, each layered over
 * a successful default. Every capture is appended to `calls`.
 */
export function codexExec(
  spawn: Exec['spawn'],
  answers: {
    cache?: Partial<ExecResult>;
    prime?: Partial<ExecResult>;
    registry?: Partial<ExecResult>;
  } = {},
  calls: CaptureCall[] = [],
): Exec {
  return {
    capture: (command, args, options) => {
      calls.push({ args, command, options });
      const answer =
        command === 'npm' && args[0] === 'view'
          ? { stdout: '0.169.0\n', ...answers.registry }
          : command === 'npm' && args[0] === 'config'
            ? { stdout: '/fake/caller/.npm\n', ...answers.cache }
            : { stdout: 'codex-cli 0.169.0\n', ...answers.prime };
      return Promise.resolve({ ...EXEC_DEFAULT, ...answer });
    },
    spawn,
  };
}
