/**
 * @file src/util/exec.ts
 * Process helpers: bounded one-shot execution with output capture, and managed
 * long-running children. Both spawn detached process groups on POSIX so that
 * package-runner wrappers (npx, uvx) and their children die together.
 *
 * The `Exec` interface is the injection seam for all of it: adapters resolve
 * `ctx.exec ?? nodeExec`, so tests substitute fakes and never spawn processes.
 */
import { type ChildProcess, spawn } from 'node:child_process';

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

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

/** Kill a child and, on POSIX, its entire process group. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      /* group may already be gone — fall through to direct kill */
    }
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
  opts: { cwd?: string; env?: Record<string, string> },
): ChildProcess {
  return spawn(command, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    detached: process.platform !== 'win32',
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Run a command to completion, capturing bounded stdout/stderr, killing the tree on timeout. */
export function execCapture(
  command: string,
  args: string[],
  opts: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawnDetached(command, args, opts);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stderr: String(error), stdout, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout, timedOut });
    });
  });
}

export interface ManagedProcess {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasExited: () => boolean;
  kill: () => void;
  stderrTail: () => string;
  stdoutTail: () => string;
}

/** Spawn a long-running child with rolling output tails and group teardown. */
export function spawnManaged(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> },
): ManagedProcess {
  const child = spawnDetached(command, args, opts);
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
    child.on('error', () => {
      exitedFlag = true;
      resolve({ code: null, signal: null });
    });
    child.on('close', (code, signal) => {
      exitedFlag = true;
      resolve({ code, signal });
    });
  });

  return {
    exited,
    hasExited: () => exitedFlag,
    kill: () => killTree(child),
    stderrTail: () => stderrTail,
    stdoutTail: () => stdoutTail,
  };
}

/**
 * The seam every adapter runs its child processes through. Swapping it lets
 * failure-path classification be tested without breaking a real upstream; it is
 * not an abstraction layer, so it carries exactly the two calls `exec.ts` offers.
 */
export interface Exec {
  capture(command: string, args: string[], opts: ExecOptions): Promise<ExecResult>;
  spawn(
    command: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> },
  ): ManagedProcess;
}

/** Real child processes — the default for every adapter run. */
export const nodeExec: Exec = { capture: execCapture, spawn: spawnManaged };

/** Compress process output into a short single-line excerpt for findings and status detail. */
export function excerpt(text: string, maxLength = 400): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}
