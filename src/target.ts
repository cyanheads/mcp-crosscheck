/**
 * @file src/target.ts
 * The one definition of how a stdio target is started. Ground truth, its canary,
 * and the launcher every client runs (`src/launch-target.ts`) all start the
 * target from a `TargetLaunch`: the command and arguments as given, the SDK's
 * default environment plus `--env` and nothing else, and the caller's working
 * directory. A diff then measures the client, not how it launched the target.
 */
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

import type { TargetSpec } from './types.js';

/** Exactly what the target is started with, on every path. Also the launcher's spec file format. */
export const TargetLaunchSchema = z.strictObject({
  args: z.array(z.string()),
  command: z.string(),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
});

export type TargetLaunch = z.infer<typeof TargetLaunchSchema>;

/**
 * The target's canonical environment: the variables the SDK's stdio transport
 * inherits by default (`HOME`, `PATH`, and the like on POSIX), read from this
 * process, plus the caller's `--env` values, which win.
 */
export function targetEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  return { ...getDefaultEnvironment(), ...env };
}

/** How `target` is started: as given, with the canonical environment, in this process's working directory. */
export function targetLaunch(target: Extract<TargetSpec, { kind: 'stdio' }>): TargetLaunch {
  return {
    args: target.args,
    command: target.command,
    cwd: process.cwd(),
    env: targetEnvironment(target.env),
  };
}
