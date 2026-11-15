/**
 * @file src/adapters/inspector.ts
 * MCP Inspector CLI adapter. Runs `@modelcontextprotocol/inspector --cli`
 * headlessly for a verbatim `tools/list`, doubling as the protocol-handshake
 * baseline, plus an optional `tools/call` canary round-trip.
 *
 * Every invocation in a run spawns one exact release: the pin, or latest as
 * the registry reports it once at the start of the run. npx runs a globally
 * installed copy for a bare package name whatever its version, but for a
 * versioned spec only when it is that same release.
 *
 * A stdio target arrives as the launcher command line (src/launch-target.ts),
 * which carries the target's own command, arguments, and environment in its
 * spec file. Inspector sees none of them, so its own argument parsing, which
 * varies by release, never touches them.
 *
 * The canary goes out as a single `--tool-args-json` object, which the client
 * passes through untouched. Its `--tool-arg key=value` alternative runs every
 * value through `JSON.parse` and keeps the raw text only when that throws, so a
 * string spelled `"123"` would arrive as a number and an empty one would be
 * rejected outright — a healthy server reported as a failed round-trip.
 */
import { z } from 'zod';

import { renderedPropertiesFromJsonSchema, renderedToolFromJsonSchema } from '../schema.js';
import type {
  Adapter,
  AdapterContext,
  AdapterRunResult,
  CanaryOutcome,
  RenderedSurface,
  TargetSpec,
} from '../types.js';
import { type Exec, type ExecResult, excerpt, nodeExec } from '../util/exec.js';
import { npmLatestVersion } from '../util/versions.js';

const PACKAGE = '@modelcontextprotocol/inspector';

const ListToolsOutput = z.object({
  tools: z.array(
    z.object({
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
      name: z.string(),
      outputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const CallToolOutput = z.object({
  content: z.array(z.record(z.string(), z.unknown())).optional(),
  isError: z.boolean().optional(),
});

/** The client's argv up to `--method`; `spec` is the one package spec the run spawns. */
function baseArgs(ctx: AdapterContext, spec: string): string[] {
  const { target } = ctx;
  if (target.kind === 'http') {
    const headerFlags = Object.entries(target.headers ?? {}).flatMap(([name, value]) => [
      '--header',
      `${name}: ${value}`,
    ]);
    return ['-y', spec, '--cli', target.url, '--transport', 'http', ...headerFlags];
  }
  return ['-y', spec, '--cli', target.command, ...target.args];
}

function parseJsonLoose(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function resolveVersion(ctx: AdapterContext, exec: Exec): Promise<string | null> {
  const pin = ctx.pins.inspector;
  if (pin !== undefined) return Promise.resolve(pin);
  // The inspector binary has no --version flag — a bare invocation launches
  // its UI server and never exits — so latest resolves via the registry.
  return npmLatestVersion(PACKAGE, ctx.workDir, exec);
}

/** Why npx never started, or null when it did. Only a missing npx gets its own wording. */
function spawnFailureDetail(ctx: AdapterContext, result: ExecResult): string | null {
  if (result.spawnErrorCode === undefined) return null;
  return result.spawnErrorCode === 'ENOENT'
    ? 'npx is not on PATH — it ships with npm, part of Node.js'
    : excerpt(ctx.redact(`npx could not start — ${result.stderr}`));
}

/**
 * The detail for an exit-0 output that did not parse: its size in bytes and
 * whether crosscheck's capture limit cut it, never its text, which can hold
 * schema prose that reads like an error.
 */
function unparsedDetail(method: 'tools/call' | 'tools/list', result: ExecResult): string {
  const bytes = Buffer.byteLength(result.stdout);
  return result.stdoutTruncated === true
    ? `${method} output exceeded the capture limit (${bytes} bytes captured)`
    : `${method} output did not parse (${bytes} bytes)`;
}

/** The detail for a non-zero exit: what the client printed, stderr first. */
function exitDetail(ctx: AdapterContext, result: ExecResult): string {
  return excerpt(ctx.redact(result.stderr === '' ? result.stdout : result.stderr));
}

/** First release carrying `--tool-args-json`, which passes argument values verbatim. */
const TOOL_ARGS_JSON_MAJOR = 2;

/**
 * Canary flags for the resolved client, or null when it cannot express these
 * arguments. Before 2.0.0 the only encoding is `--tool-arg key=value`, whose
 * value side is text: a non-string argument has no faithful spelling there, and
 * an empty one has nothing to spell. An unresolved version means latest, which
 * carries the flag.
 */
function canaryArgFlags(
  args: Record<string, unknown>,
  resolvedVersion: string | null,
): string[] | null {
  const major = Number(resolvedVersion?.split('.')[0]);
  if (!Number.isInteger(major) || major >= TOOL_ARGS_JSON_MAJOR) {
    return ['--tool-args-json', JSON.stringify(args)];
  }
  const flags: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || value === '') return null;
    flags.push('--tool-arg', `${key}=${value}`);
  }
  return flags;
}

async function runCanary(
  ctx: AdapterContext,
  exec: Exec,
  spec: string,
  resolvedVersion: string | null,
): Promise<CanaryOutcome | null> {
  if (ctx.canary === null) return null;
  const argFlags = canaryArgFlags(ctx.canary.args, resolvedVersion);
  if (argFlags === null) {
    return {
      attempted: false,
      detail:
        'this inspector predates --tool-args-json, and --tool-arg cannot carry a non-string or empty argument',
      ok: null,
    };
  }
  const result = await exec.capture(
    'npx',
    [...baseArgs(ctx, spec), '--method', 'tools/call', '--tool-name', ctx.canary.tool, ...argFlags],
    { cwd: ctx.workDir, timeoutMs: ctx.timeoutMs },
  );
  const failed = (detail: string): CanaryOutcome => ({ attempted: true, detail, ok: false });
  if (result.timedOut) return failed(`timed out after ${ctx.timeoutMs}ms`);
  const notStarted = spawnFailureDetail(ctx, result);
  if (notStarted !== null) return failed(notStarted);
  if (result.code !== 0) return failed(exitDetail(ctx, result));
  const parsed = CallToolOutput.safeParse(parseJsonLoose(result.stdout));
  if (!parsed.success) return failed(unparsedDetail('tools/call', result));
  if (parsed.data.isError === true) {
    const first = parsed.data.content?.[0];
    const text = first !== undefined && typeof first.text === 'string' ? first.text : 'isError';
    return failed(excerpt(ctx.redact(`server rejected the call — ${text}`)));
  }
  return { attempted: true, detail: null, ok: true };
}

/**
 * Classified in order: a timeout (`handshake-failure`), an npx that never
 * started (`adapter-broken`), a non-zero exit (`adapter-broken` when npm could
 * not install the client, `handshake-failure` otherwise), and an exit-0 output
 * that did not parse (`capture-failure`).
 */
async function run(ctx: AdapterContext): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  const exec = ctx.exec ?? nodeExec;
  const resolvedVersion = await resolveVersion(ctx, exec);
  const spec = `${PACKAGE}@${resolvedVersion ?? 'latest'}`;
  ctx.log(`inspector: running ${spec}, listing tools`);

  const result = await exec.capture('npx', [...baseArgs(ctx, spec), '--method', 'tools/list'], {
    cwd: ctx.workDir,
    timeoutMs: ctx.timeoutMs,
  });

  const finish = (partial: Omit<AdapterRunResult, 'adapter' | 'durationMs' | 'resolvedVersion'>) =>
    ({
      adapter: 'inspector',
      durationMs: Date.now() - startedAt,
      resolvedVersion,
      ...partial,
    }) satisfies AdapterRunResult;
  const failed = (status: AdapterRunResult['status'], statusDetail: string) =>
    finish({ canary: null, status, statusDetail, surface: null });

  if (result.timedOut) return failed('handshake-failure', `timed out after ${ctx.timeoutMs}ms`);
  const notStarted = spawnFailureDetail(ctx, result);
  if (notStarted !== null) return failed('adapter-broken', notStarted);
  if (result.code !== 0) {
    const installFailure = /npm (err|error)|E404|EOVERRIDE|ENOTFOUND/i.test(result.stderr);
    const detail = exitDetail(ctx, result);
    return failed(
      installFailure ? 'adapter-broken' : 'handshake-failure',
      detail === '' ? `exit code ${result.code}` : detail,
    );
  }
  const parsed = ListToolsOutput.safeParse(parseJsonLoose(result.stdout));
  if (!parsed.success) return failed('capture-failure', unparsedDetail('tools/list', result));

  const surface: RenderedSurface = {
    tools: parsed.data.tools.map((tool) => {
      const rendered = renderedToolFromJsonSchema(
        tool.name,
        tool.description ?? null,
        tool.inputSchema ?? {},
      );
      if (tool.outputSchema !== undefined) {
        rendered.outputProperties = renderedPropertiesFromJsonSchema(tool.outputSchema);
      }
      return rendered;
    }),
  };

  const canary = await runCanary(ctx, exec, spec, resolvedVersion);
  return finish({ canary, status: 'ok', statusDetail: null, surface });
}

/** MCP Inspector CLI — verbatim `tools/list`, stdio and streamable-http. */
export const inspectorAdapter: Adapter = {
  name: 'inspector',
  optIn: false,
  run,
  supports: (_target: TargetSpec) => true,
};
