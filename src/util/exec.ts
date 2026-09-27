/**
 * @file src/util/exec.ts
 * Process helpers: bounded one-shot execution with output capture, and managed
 * long-running children. Both spawn detached process groups on POSIX so that
 * package-runner wrappers (npx, uvx) and their children die together: on a
 * timeout or kill while the leader runs, and the moment the leader exits, when
 * anything it left in the group is an orphan. Output is decoded as UTF-8 across
 * pipe chunks, and no call waits on a pipe past `PIPE_DRAIN_GRACE_MS` after
 * its child exits, whoever still holds it.
 *
 * The `Exec` interface is the injection seam for all of it: adapters resolve
 * `ctx.exec ?? nodeExec`, so tests substitute fakes and never spawn processes.
 */
import {
  type ChildProcess,
  type SpawnOptions as NodeSpawnOptions,
  spawn,
} from 'node:child_process';
import { win32 as win32Path } from 'node:path';

/** Cap captured output so a runaway child cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
/** Keep this much recent output for error reporting on managed children. */
const TAIL_BYTES = 64 * 1024;
/**
 * How long a child's pipes may stay open after it exits. A descendant beyond
 * teardown's reach (one that left the process group on POSIX, or any
 * descendant on Windows once the leader is gone) can hold them indefinitely;
 * past this grace they are cut and the call returns without them.
 */
const PIPE_DRAIN_GRACE_MS = 1_000;

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The command never started: the spawn error's code, such as `ENOENT` for a command not on PATH. */
  spawnErrorCode?: string;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** False starts the child with only `env`; omitted preserves inherited-environment behavior. */
  inheritEnv?: boolean;
}

export interface ExecOptions extends SpawnOptions {
  timeoutMs: number;
}

interface SpawnCommand {
  args: string[];
  command: string;
}

type ChildSpawn = (command: string, args: string[], options: NodeSpawnOptions) => ChildProcess;

interface NodeExecDependencies {
  execPath: string;
  kill: typeof process.kill;
  platform: NodeJS.Platform;
  spawn: ChildSpawn;
}

const SYSTEM_DEPENDENCIES: NodeExecDependencies = {
  execPath: process.execPath,
  kill: process.kill,
  platform: process.platform,
  spawn,
};

/**
 * Node's own npm CLIs by bare command. On Windows a bare `npm` or `npx` reaches
 * only its `.cmd` shim, which `spawn` cannot launch without a shell.
 */
const WINDOWS_NPM_CLIS = new Map([
  ['npm', 'npm-cli.js'],
  ['npx', 'npx-cli.js'],
]);

/** Resolve Windows `npm` and `npx` to Node's npm CLIs without routing arbitrary commands through a shell. */
export function resolveSpawnCommand(
  command: string,
  args: string[],
  platform = process.platform,
  execPath = process.execPath,
): SpawnCommand {
  const cli = platform === 'win32' ? WINDOWS_NPM_CLIS.get(command) : undefined;
  if (cli === undefined) return { args, command };
  return {
    args: [win32Path.join(win32Path.dirname(execPath), 'node_modules', 'npm', 'bin', cli), ...args],
    command: execPath,
  };
}

/**
 * Kill a live child and its platform-native process tree. A child that has
 * already exited is left alone: on POSIX its exit already swept the group (see
 * `superviseExit`), and signalling the group ID again later could reach an
 * unrelated group that has since reused it.
 */
export function killTree(
  child: ChildProcess,
  overrides: Partial<Pick<NodeExecDependencies, 'kill' | 'platform' | 'spawn'>> = {},
): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const dependencies = { ...SYSTEM_DEPENDENCIES, ...overrides };
  if (dependencies.platform === 'win32') {
    try {
      const taskkill = dependencies.spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        detached: false,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      taskkill.on('error', () => {});
      taskkill.unref?.();
    } catch {
      /* best-effort teardown */
    }
    return;
  }
  try {
    dependencies.kill(-child.pid, 'SIGKILL');
    return;
  } catch {
    /* group may already be gone — fall through to direct kill */
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already exited */
  }
}

function spawnDetached(
  command: string,
  args: string[],
  opts: SpawnOptions,
  dependencies: NodeExecDependencies,
): ChildProcess {
  const resolved = resolveSpawnCommand(command, args, dependencies.platform, dependencies.execPath);
  return dependencies.spawn(resolved.command, resolved.args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    detached: dependencies.platform !== 'win32',
    env: opts.inheritEnv === false ? (opts.env ?? {}) : { ...process.env, ...opts.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Report a child's end exactly once: on `close`, when every holder of its pipes
 * is gone, or `PIPE_DRAIN_GRACE_MS` after the leader exits, when a descendant
 * beyond reach still holds them and they are cut instead. On POSIX the leader's
 * exit also SIGKILLs its process group, since anything it left there is an
 * orphan. The group ID stays reserved while any member lives, so this is the
 * last moment it is known to name only this child's descendants.
 */
function superviseExit(
  child: ChildProcess,
  dependencies: NodeExecDependencies,
  onEnd: (exit: ChildExit, error: NodeJS.ErrnoException | null) => void,
): void {
  let ended = false;
  let drain: ReturnType<typeof setTimeout> | undefined;
  const end = (exit: ChildExit, error: NodeJS.ErrnoException | null = null) => {
    if (ended) return;
    ended = true;
    clearTimeout(drain);
    onEnd(exit, error);
  };

  child.on('exit', (code, signal) => {
    if (dependencies.platform !== 'win32' && child.pid !== undefined) {
      try {
        dependencies.kill(-child.pid, 'SIGKILL');
      } catch {
        /* the leader left nothing behind in its group */
      }
    }
    // The immediate defers the cut past one poll phase, so a loop stalled for
    // the whole grace still reads the output and EOF already waiting on the pipes.
    drain = setTimeout(
      () =>
        setImmediate(() => {
          if (ended) return;
          child.stdout?.destroy();
          child.stderr?.destroy();
          end({ code, signal });
        }),
      PIPE_DRAIN_GRACE_MS,
    );
  });
  child.on('close', (code, signal) => end({ code, signal }));
  child.on('error', (error) => end({ code: null, signal: null }, error));
}

/** The last `TAIL_BYTES` of `text`, never opening on the second half of a surrogate pair. */
function keepTail(text: string): string {
  const kept = text.slice(-TAIL_BYTES);
  const first = kept.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? kept.slice(1) : kept;
}

function execCaptureWith(
  command: string,
  args: string[],
  opts: ExecOptions,
  dependencies: NodeExecDependencies,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawnDetached(command, args, opts, dependencies);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk;
    });

    // The budget bounds the command itself; once it exits, the drain grace bounds the rest.
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, dependencies);
    }, opts.timeoutMs);
    child.on('exit', () => clearTimeout(timer));

    superviseExit(child, dependencies, ({ code, signal }, error) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        ...(error?.code === undefined ? {} : { spawnErrorCode: error.code }),
        stderr: error === null ? stderr : String(error),
        stdout,
        timedOut,
      });
    });
  });
}

function spawnManagedWith(
  command: string,
  args: string[],
  opts: SpawnOptions,
  dependencies: NodeExecDependencies,
): ManagedProcess {
  const child = spawnDetached(command, args, opts, dependencies);
  let stdoutTail = '';
  let stderrTail = '';
  let ended = false;

  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdoutTail = keepTail(stdoutTail + chunk);
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderrTail = keepTail(stderrTail + chunk);
  });

  const exited = new Promise<ChildExit>((resolve) => {
    superviseExit(child, dependencies, (exit) => {
      ended = true;
      resolve(exit);
    });
  });

  return {
    exited,
    hasExited: () => ended,
    kill: () => killTree(child, dependencies),
    stderrTail: () => stderrTail,
    stdoutTail: () => stdoutTail,
  };
}

/** Build the real Exec seam or an isolated platform variant for process-level tests. */
export function createNodeExec(overrides: Partial<NodeExecDependencies> = {}): Exec {
  const dependencies = { ...SYSTEM_DEPENDENCIES, ...overrides };
  return {
    capture: (command, args, opts) => execCaptureWith(command, args, opts, dependencies),
    spawn: (command, args, opts) => spawnManagedWith(command, args, opts, dependencies),
  };
}

/**
 * Run a command to completion, capturing bounded stdout/stderr. The tree is
 * killed on timeout, and whatever the command leaves running in its group is
 * killed when it exits.
 */
export function execCapture(
  command: string,
  args: string[],
  opts: ExecOptions,
): Promise<ExecResult> {
  return execCaptureWith(command, args, opts, SYSTEM_DEPENDENCIES);
}

export interface ManagedProcess {
  /** Settles when the child's pipes close, or within `PIPE_DRAIN_GRACE_MS` of its exit. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasExited: () => boolean;
  kill: () => void;
  stderrTail: () => string;
  stdoutTail: () => string;
}

/** Spawn a long-running child with rolling output tails and group teardown. */
export function spawnManaged(command: string, args: string[], opts: SpawnOptions): ManagedProcess {
  return spawnManagedWith(command, args, opts, SYSTEM_DEPENDENCIES);
}

/**
 * The seam every adapter runs its child processes through. Swapping it lets
 * failure-path classification be tested without breaking a real upstream; it is
 * not an abstraction layer, so it carries exactly the two calls `exec.ts` offers.
 */
export interface Exec {
  capture(command: string, args: string[], opts: ExecOptions): Promise<ExecResult>;
  spawn(command: string, args: string[], opts: SpawnOptions): ManagedProcess;
}

/** Real child processes — the default for every adapter run. */
export const nodeExec: Exec = createNodeExec();

const BOX_DRAWING_ONLY = /^[\s\u2500-\u257f]+$/u;
const ERROR_SHAPED =
  /\b(?:error|exception|traceback|importerror|modulenotfounderror|cannot|failed)\b|\berr!/i;
const WARNING_SHAPED = /\bwarn(?:ing)?\b/i;

/** Compress process output into a short single-line excerpt for findings and status detail. */
export function excerpt(text: string, maxLength = 400): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
    throw new RangeError('maxLength must be a non-negative safe integer');
  }

  const lines = text
    .split(/\r\n?|\n/u)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '' && !BOX_DRAWING_ONLY.test(line));
  let offset = 0;
  let lastErrorEnd = -1;
  for (const [index, line] of lines.entries()) {
    if (index > 0) offset += 1;
    offset += line.length;
    if (!WARNING_SHAPED.test(line) && ERROR_SHAPED.test(line)) lastErrorEnd = offset;
  }
  const flat = lines.join(' ');
  if (flat.length <= maxLength) return flat;
  if (lastErrorEnd === -1) return `${flat.slice(0, maxLength)}…`;
  if (maxLength === 0) return '…';
  const omittedAfter = lastErrorEnd < flat.length;
  const contentLength = omittedAfter ? maxLength - 1 : maxLength;
  const start = Math.max(0, lastErrorEnd - contentLength);
  return `${start > 0 ? '…' : ''}${flat.slice(start, lastErrorEnd)}${omittedAfter ? '…' : ''}`;
}
