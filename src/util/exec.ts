/**
 * @file src/util/exec.ts
 * Process helpers: bounded one-shot execution with output capture, and managed
 * long-running children. Both spawn detached process groups on POSIX so that
 * package-runner wrappers (npx, uvx) and their children die together.
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

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
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
  spawn: (command, args, options) => spawn(command, args, options),
};

/** Resolve the one known Windows command shim without routing arbitrary commands through a shell. */
export function resolveSpawnCommand(
  command: string,
  args: string[],
  platform = process.platform,
  execPath = process.execPath,
): SpawnCommand {
  if (platform !== 'win32' || command !== 'npx') return { args, command };
  return {
    args: [
      win32Path.join(win32Path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      ...args,
    ],
    command: execPath,
  };
}

/** Kill a child and its platform-native process tree. */
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
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, dependencies);
    }, opts.timeoutMs);
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (error) => {
      finish({ code: null, signal: null, stderr: String(error), stdout, timedOut });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, stderr, stdout, timedOut });
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
  let exitedFlag = false;

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutTail = (stdoutTail + chunk.toString('utf8')).slice(-TAIL_BYTES);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-TAIL_BYTES);
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      exitedFlag = true;
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.on('error', () => finish(null, null));
    child.on('close', finish);
  });

  return {
    exited,
    hasExited: () => exitedFlag,
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

/** Run a command to completion, capturing bounded stdout/stderr, killing the tree on timeout. */
export function execCapture(
  command: string,
  args: string[],
  opts: ExecOptions,
): Promise<ExecResult> {
  return execCaptureWith(command, args, opts, SYSTEM_DEPENDENCIES);
}

export interface ManagedProcess {
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
