/**
 * @file src/adapters/inspector.ts
 * MCP Inspector CLI adapter. Runs `@modelcontextprotocol/inspector --cli`
 * headlessly for a verbatim `tools/list`, doubling as the protocol-handshake
 * baseline, plus an optional `tools/call` canary round-trip.
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
import { type Exec, excerpt, nodeExec } from '../util/exec.js';
import { npmLatestVersion } from '../util/versions.js';

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

function packageSpec(ctx: AdapterContext): string {
  const pin = ctx.pins.inspector;
  return pin === undefined
    ? '@modelcontextprotocol/inspector'
    : `@modelcontextprotocol/inspector@${pin}`;
}

function baseArgs(ctx: AdapterContext): string[] {
  const { target } = ctx;
  if (target.kind === 'http') {
    return ['-y', packageSpec(ctx), '--cli', target.url, '--transport', 'http'];
  }
  const envFlags = Object.entries(target.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return ['-y', packageSpec(ctx), '--cli', ...envFlags, target.command, ...target.args];
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
  return npmLatestVersion('@modelcontextprotocol/inspector', ctx.workDir, exec);
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
    [...baseArgs(ctx), '--method', 'tools/call', '--tool-name', ctx.canary.tool, ...argFlags],
    { cwd: ctx.workDir, timeoutMs: ctx.timeoutMs },
  );
  if (result.code !== 0) {
    return {
      attempted: true,
      detail: excerpt(result.stderr === '' ? result.stdout : result.stderr),
      ok: false,
    };
  }
  const parsed = CallToolOutput.safeParse(parseJsonLoose(result.stdout));
  if (!parsed.success) {
    return { attempted: true, detail: 'tools/call output was not parseable JSON', ok: false };
  }
  if (parsed.data.isError === true) {
    const first = parsed.data.content?.[0];
    const text = first !== undefined && typeof first.text === 'string' ? first.text : 'isError';
    return { attempted: true, detail: excerpt(`server rejected the call — ${text}`), ok: false };
  }
  return { attempted: true, detail: null, ok: true };
}

async function run(ctx: AdapterContext): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  const exec = ctx.exec ?? nodeExec;
  const resolvedVersion = await resolveVersion(ctx, exec);
  ctx.log(`inspector: resolved ${resolvedVersion ?? 'unknown version'}, listing tools`);

  const result = await exec.capture('npx', [...baseArgs(ctx), '--method', 'tools/list'], {
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

  if (result.timedOut) {
    return finish({
      canary: null,
      status: 'handshake-failure',
      statusDetail: `timed out after ${ctx.timeoutMs}ms`,
      surface: null,
    });
  }

  const parsed = ListToolsOutput.safeParse(parseJsonLoose(result.stdout));
  if (result.code !== 0 || !parsed.success) {
    const stderr = excerpt(result.stderr === '' ? result.stdout : result.stderr);
    const installFailure = /npm (err|error)|E404|EOVERRIDE|ENOTFOUND/i.test(result.stderr);
    return finish({
      canary: null,
      status: installFailure ? 'adapter-broken' : 'handshake-failure',
      statusDetail: stderr === '' ? `exit code ${result.code}` : stderr,
      surface: null,
    });
  }

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

  const canary = await runCanary(ctx, exec, resolvedVersion);
  return finish({ canary, status: 'ok', statusDetail: null, surface });
}

/** MCP Inspector CLI — verbatim `tools/list`, stdio and streamable-http. */
export const inspectorAdapter: Adapter = {
  name: 'inspector',
  optIn: false,
  run,
  supports: (_target: TargetSpec) => true,
};
