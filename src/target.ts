/**
 * @file src/target.ts
 * Pure lexical normalization for target tokens whose relative-path intent is explicit.
 */
import { posix, win32 } from 'node:path';

import type { TargetSpec } from './types.js';

/** On Windows both separators mark an explicit-relative token: `./`, `../`, `.\`, `..\`. */
const WIN32_EXPLICIT_RELATIVE = /^\.\.?[\\/]/u;

function canonicalizeToken(token: string, cwd: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return WIN32_EXPLICIT_RELATIVE.test(token) ? win32.resolve(cwd, token) : token;
  }
  return token.startsWith('./') || token.startsWith('../') ? posix.resolve(cwd, token) : token;
}

/**
 * Resolve explicit-relative stdio tokens once, without inspecting the filesystem.
 * `platform` selects the path semantics, so both spellings are testable on any host.
 */
export function canonicalizeTarget(
  target: TargetSpec,
  cwd: string,
  platform: NodeJS.Platform,
): TargetSpec {
  if (target.kind === 'http') return target;
  return {
    args: target.args.map((arg) => canonicalizeToken(arg, cwd, platform)),
    command: canonicalizeToken(target.command, cwd, platform),
    env: target.env,
    kind: 'stdio',
  };
}
