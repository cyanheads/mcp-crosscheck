/**
 * @file tests/e2e/harness.ts
 * Shared constants and helpers for the end-to-end lanes, which run against the
 * bundled fixture server and are layered by cost. One file per lane:
 *
 *   1. hermetic core — `bun test tests/e2e/hermetic.test.ts`: the programmatic
 *      API over stdio and streamable-http
 *   2. CLI process   — `bun test tests/e2e/cli.test.ts`: the real CLI: help,
 *      version, usage exit codes
 *   3. inspector     — `tests/e2e/inspector.test.ts`, CROSSCHECK_E2E_NETWORK=1
 *      (npx resolves the client)
 *   4. mcpo          — `tests/e2e/mcpo.test.ts`, CROSSCHECK_E2E_NETWORK=1 and
 *      `uv` on PATH
 *   5. codex         — `tests/e2e/codex.test.ts`, CROSSCHECK_E2E_CODEX=1 (boots
 *      the full Codex binary)
 *   6. claude-code   — `tests/e2e/claude-code.test.ts`, CROSSCHECK_E2E_CLAUDE_CODE=1
 *      (installed Claude Code)
 *
 * A bare `bun test` runs lanes 1 and 2 plus each client file's ungated
 * orchestration tests, which drive `runCrosscheck` through a fake `Exec`: no
 * network, no binaries beyond bun itself. The gated lanes resolve their clients
 * at latest, so they belong in a deliberate run rather than the default suite.
 *
 * Every client starts a stdio target through the crosscheck launcher, which runs
 * it the way ground truth does: in the caller's directory, with the SDK's default
 * environment plus `--env`. Adapter package runners still launch from a neutral
 * scratch cwd.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { CanarySpec } from '../../src/types.js';
import { type ExecResult, execCapture } from '../../src/util/exec.js';

export const REPO_ROOT = join(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
export const FIXTURE_SERVER = join(import.meta.dir, '..', 'fixture-server', 'server.ts');
/** Pinned so version resolution short-circuits instead of calling `npm view`. */
export const INSPECTOR_PIN = '2.1.0';
export const TIMEOUT_MS = 30_000;
export const NETWORK_LANES = process.env.CROSSCHECK_E2E_NETWORK === '1';

/** `repeat` is an integer: every adapter has to carry a non-string argument through unchanged. */
export const CANARY: CanarySpec = { args: { message: 'probe', repeat: 2 }, tool: 'echo_message' };
/** The same canary as the `--canary '<tool>={json}'` flag spells it. */
export const CANARY_FLAG = `${CANARY.tool}=${JSON.stringify(CANARY.args)}`;
/** The fixture's one tool with an `outputSchema`, on page 4 of 6 when the fixture pages one tool at a time. */
export const NESTED_CANARY: CanarySpec = {
  args: { config: { retries: 1 } },
  tool: 'nested_config',
};

export function runCli(
  args: string[],
  timeoutMs = 60_000,
  env: Record<string, string> = {},
): Promise<ExecResult> {
  return execCapture(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, timeoutMs });
}

/** Refuses every connection, so a run that gets past validation fails fast at ground truth. */
export const UNREACHABLE_URL = 'http://127.0.0.1:1/mcp';

/** One line a fixture started with `MCP_FIXTURE_PROBE_PATH` records per start. */
interface LaunchProbe {
  argv: string[];
  cwd: string;
  envNames: string[];
  home: string | null;
}

export async function launchProbes(path: string): Promise<LaunchProbe[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LaunchProbe);
}

/** Ground truth's environment, by name: the SDK's default inherited set plus `--env`. */
export function canonicalEnvNames(passed: Record<string, string>, extra: string[] = []): string[] {
  return [
    ...new Set([...Object.keys(getDefaultEnvironment()), ...Object.keys(passed), ...extra]),
  ].sort();
}
