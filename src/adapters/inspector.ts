/**
 * @file src/adapters/inspector.ts
 * MCP Inspector CLI adapter. Runs `@modelcontextprotocol/inspector --cli`
 * headlessly for a verbatim `tools/list`, doubling as the protocol-handshake
 * baseline, plus an optional `tools/call` canary round-trip.
 */
import { z } from 'zod';

import { renderedToolFromJsonSchema } from '../schema.js';
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

function serializeToolArg(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function runCanary(ctx: AdapterContext, exec: Exec): Promise<CanaryOutcome | null> {
  if (ctx.canary === null) return null;
  const argFlags = Object.entries(ctx.canary.args).flatMap(([key, value]) => [
    '--tool-arg',
    `${key}=${serializeToolArg(value)}`,
  ]);
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
    tools: parsed.data.tools.map((tool) =>
      renderedToolFromJsonSchema(tool.name, tool.description ?? null, tool.inputSchema ?? {}),
    ),
  };

  const canary = await runCanary(ctx, exec);
  return finish({ canary, status: 'ok', statusDetail: null, surface });
}

/** MCP Inspector CLI — verbatim `tools/list`, stdio and streamable-http. */
export const inspectorAdapter: Adapter = {
  name: 'inspector',
  optIn: false,
  run,
  supports: (_target: TargetSpec) => true,
};
