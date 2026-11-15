/**
 * @file src/launch-target.ts
 * The stdio target launcher every client starts in the target's place, as
 * `<node> launch-target.js <spec.json>`. It starts the target its spec
 * describes (a `TargetLaunch`) with exactly that command, those arguments,
 * that environment and nothing inherited, in that working directory, through
 * `cross-spawn`, the spawner the SDK's stdio transport uses for ground truth.
 * The target shares the launcher's stdio, so the client speaks to it directly.
 *
 * SIGHUP, SIGINT, and SIGTERM are passed on to the target, and the launcher
 * ends the way the target ended: with its exit code, or by raising the signal
 * that ended it. A launcher orphaned by its client's death stops the target.
 * A target that cannot be started is one stderr line naming the command, and
 * exit code 127.
 */
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';

import spawn from 'cross-spawn';

import { TargetLaunchSchema } from './target.js';

const FORWARDED_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

const [specPath] = process.argv.slice(2);
if (specPath === undefined) throw new Error('usage: launch-target <spec.json>');
const spec = TargetLaunchSchema.parse(JSON.parse(readFileSync(specPath, 'utf8')));

const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  stdio: 'inherit',
  windowsHide: true,
});

for (const signal of FORWARDED_SIGNALS) {
  process.on(signal, () => child.kill(signal));
}

/**
 * A client killed outright passes nothing on, and some start the launcher in
 * a session of its own (Python `mcp` uses `start_new_session`), out of reach
 * of the group kill that ends the client. Being reparented is the only sign:
 * the target gets SIGTERM, then SIGKILL on the next check. Inert on Windows,
 * which never reparents, and whose tree kill already reaches the target.
 */
const parentPid = process.ppid;
let orphaned = false;
setInterval(() => {
  if (process.ppid === parentPid) return;
  child.kill(orphaned ? 'SIGKILL' : 'SIGTERM');
  orphaned = true;
}, 500).unref();

// exitCode rather than process.exit: on macOS a stderr pipe is written asynchronously.
child.on('error', (error) => {
  process.stderr.write(
    `mcp-crosscheck launch-target: could not start ${spec.command}: ${error.message}\n`,
  );
  process.exitCode = 127;
});

child.on('exit', (code, signal) => {
  if (signal === null) {
    process.exitCode = code;
    return;
  }
  // The shell's status for a signal death, which stands if raising it does not end this process.
  process.exitCode = 128 + constants.signals[signal];
  // Raised on Node, SIGUSR1 would start the inspector rather than end the process.
  if (signal === 'SIGUSR1') return;
  for (const forwarded of FORWARDED_SIGNALS) process.removeAllListeners(forwarded);
  process.kill(process.pid, signal);
});
