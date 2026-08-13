/**
 * @file src/target.ts
 * Pure lexical normalization for target tokens whose relative-path intent is explicit.
 */
import { resolve } from 'node:path';

import type { TargetSpec } from './types.js';

function canonicalizeToken(token: string, cwd: string): string {
  return token.startsWith('./') || token.startsWith('../') ? resolve(cwd, token) : token;
}

/** Resolve explicit-relative stdio tokens once, without inspecting the filesystem. */
export function canonicalizeTarget(target: TargetSpec, cwd: string): TargetSpec {
  if (target.kind === 'http') return target;
  return {
    args: target.args.map((arg) => canonicalizeToken(arg, cwd)),
    command: canonicalizeToken(target.command, cwd),
    env: target.env,
    kind: 'stdio',
  };
}
