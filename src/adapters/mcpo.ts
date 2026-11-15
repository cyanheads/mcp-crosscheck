/**
 * @file src/adapters/mcpo.ts
 * mcpo adapter (open-webui's MCP → OpenAPI proxy). Boots `uvx mcpo` against
 * the target, reads the generated openapi.json as the rendered surface, and
 * optionally round-trips the canary as a live POST. Requires `uv` on PATH.
 *
 * An unpinned run resolves latest from PyPI once and spawns exactly that
 * release, so a `uv tool install`-ed copy of another version never runs in its
 * place. The proxy itself runs with the caller's environment; a stdio target
 * arrives as the launcher command line (src/launch-target.ts), which applies
 * the target's own environment.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isRecord,
  renderedPropertiesFromJsonSchema,
  renderedToolFromJsonSchema,
} from '../schema.js';
import type {
  Adapter,
  AdapterContext,
  AdapterRunResult,
  CanaryOutcome,
  RenderedProperty,
  RenderedSurface,
  RenderedTool,
  TargetSpec,
} from '../types.js';
import { type ChildExit, excerpt, nodeExec } from '../util/exec.js';
import { type FetchJsonResult, fetchJson, getFreePort, waitForReady } from '../util/net.js';
import { pypiLatestVersion } from '../util/versions.js';

/** A `uvx --with` requirement mcpo runs under unless a caller entry names the same package. */
interface DefaultConstraint {
  /** The package's PEP 503 normalized name. */
  name: string;
  requirement: string;
}

/**
 * Python `mcp` 2.x removed `mcp.client.streamable_http.streamablehttp_client`,
 * which mcpo 0.0.20 imports at startup (open-webui/mcpo#303).
 */
const MCP_BELOW_2: DefaultConstraint = { name: 'mcp', requirement: 'mcp<2' };

/**
 * FastAPI 0.145.0 removed `FastAPI(**extra)`, and mcpo 0.0.20 passes
 * `ssl_certfile` to `FastAPI(...)`, so it exits with a TypeError; 0.144.0 runs.
 */
const FASTAPI_BELOW_0_145: DefaultConstraint = { name: 'fastapi', requirement: 'fastapi<0.145' };

/**
 * mcpo 0.0.20 declares `mcp` and `fastapi` with no upper bound, so an
 * unconstrained resolve breaks every run. Each default goes once a mcpo
 * release imports against current releases of its package.
 */
const DEFAULT_CONSTRAINTS = [MCP_BELOW_2, FASTAPI_BELOW_0_145];

/**
 * A PEP 508 requirement's project name, PEP 503 normalized (`MCP`, `mcp[cli]`
 * → `mcp`), or null for an entry that opens with no name, such as a path.
 */
function requirementName(requirement: string): string | null {
  const name = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(requirement)?.[1];
  return name === undefined ? null : name.replace(/[-_.]+/g, '-').toLowerCase();
}

/**
 * The defaults no `--mcpo-with` entry replaces. An entry replaces the default
 * for its own package only, since two constraints on one package would
 * intersect.
 */
function defaultsInForce(mcpoWith: readonly string[]): string[] {
  const named = new Set(mcpoWith.map(requirementName));
  return DEFAULT_CONSTRAINTS.filter(({ name }) => !named.has(name)).map(
    ({ requirement }) => requirement,
  );
}

/** The `uvx` argv: the defaults in force, then the caller's `--with` entries in order. */
function uvxArgs(ctx: AdapterContext, spec: string, defaults: string[], port: number): string[] {
  const withFlags = [...defaults, ...ctx.mcpoWith].flatMap((entry) => ['--with', entry]);
  const base = [...withFlags, spec, '--host', '127.0.0.1', '--port', String(port)];
  if (ctx.target.kind === 'http') {
    const headerEntries = Object.entries(ctx.target.headers ?? {});
    const headerFlags =
      headerEntries.length === 0 ? [] : ['--header', JSON.stringify(ctx.target.headers)];
    return [...base, '--server-type', 'streamable-http', ...headerFlags, '--', ctx.target.url];
  }
  return [...base, '--', ctx.target.command, ...ctx.target.args];
}

/**
 * Extract the rendered surface from an mcpo-generated OpenAPI document:
 * every root-level path with a `post` operation is one tool, and its
 * `application/json` request body schema is the rendered input model.
 */
export function surfaceFromOpenApiDoc(doc: unknown): RenderedSurface | null {
  if (!isRecord(doc) || !isRecord(doc.paths)) return null;
  const tools = Object.entries(doc.paths)
    .map(([path, item]) => toolFromPath(path, item, doc))
    .filter((tool): tool is RenderedTool => tool !== null);
  return { tools };
}

/** The `application/json` schema of an OpenAPI request body or response object. */
function jsonSchemaOf(container: unknown): unknown {
  if (!isRecord(container) || !isRecord(container.content)) return;
  const jsonContent = container.content['application/json'];
  if (!isRecord(jsonContent)) return;
  return jsonContent.schema;
}

/**
 * The result model mcpo generates from a tool's `outputSchema`. It arrives
 * wrapped in a union envelope — `{anyOf: [{$ref: <tool>_response_model}, {}]}` —
 * whose branches the normalizer collects, so the model's fields come through
 * without unwrapping the envelope by hand.
 */
function outputPropertiesOf(
  post: Record<string, unknown>,
  doc: unknown,
): RenderedProperty[] | null {
  if (!isRecord(post.responses)) return null;
  const schema = jsonSchemaOf(post.responses['200']);
  return schema === undefined ? null : renderedPropertiesFromJsonSchema(schema, doc);
}

/** Map one OpenAPI path item to a rendered tool; returns null for non-tool routes. */
function toolFromPath(path: string, item: unknown, doc: unknown): RenderedTool | null {
  if (!isRecord(item) || !isRecord(item.post)) return null;
  const name = path.replace(/^\//, '');
  if (name === '') return null;
  const post = item.post;
  const description =
    typeof post.description === 'string' && post.description !== ''
      ? post.description
      : typeof post.summary === 'string' && post.summary !== ''
        ? post.summary
        : null;

  // No request body at all renders as an empty surface, which the invariant
  // engine judges against whether ground truth advertises input properties.
  const inputSchema = jsonSchemaOf(post.requestBody) ?? {};
  const tool = renderedToolFromJsonSchema(name, description, inputSchema, doc);
  const outputProperties = outputPropertiesOf(post, doc);
  if (outputProperties !== null) tool.outputProperties = outputProperties;
  return tool;
}

/** The pin, or latest from PyPI; null when the lookup fails, and the run spawns `mcpo@latest`. */
function resolveVersion(ctx: AdapterContext): Promise<string | null> {
  const pin = ctx.pins.mcpo;
  return pin === undefined ? pypiLatestVersion('mcpo') : Promise.resolve(pin);
}

/** Why the proxy exited before serving, from how it ended and what it printed. */
function exitedDetail(ctx: AdapterContext, exit: ChildExit, stderr: string): string {
  if (exit.spawnErrorCode === 'ENOENT') {
    return 'uvx is not on PATH — it ships with uv (https://docs.astral.sh/uv/)';
  }
  if (exit.spawnErrorCode !== undefined) {
    return excerpt(ctx.redact(`uvx could not start — ${stderr}`));
  }
  return stderr.trim() === ''
    ? `mcpo exited before becoming ready with exit code ${exit.code}`
    : excerpt(ctx.redact(`mcpo exited before becoming ready — ${stderr}`));
}

async function runCanary(ctx: AdapterContext, port: number): Promise<CanaryOutcome | null> {
  if (ctx.canary === null) return null;
  try {
    const response = await fetchJson(`http://127.0.0.1:${port}/${ctx.canary.tool}`, {
      body: ctx.canary.args,
      method: 'POST',
      timeoutMs: ctx.timeoutMs,
    });
    if (!response.ok) {
      return {
        attempted: true,
        detail: excerpt(ctx.redact(`HTTP ${response.status} — ${response.text}`)),
        ok: false,
      };
    }
    return { attempted: true, detail: null, ok: true };
  } catch (error) {
    return { attempted: true, detail: excerpt(ctx.redact(String(error))), ok: false };
  }
}

/**
 * The first `openapi.json` response ends the wait for readiness and is the
 * capture. mcpo registers every tool route during its startup, which uvicorn
 * completes before it accepts a connection, so any HTTP answer comes from a
 * proxy that is fully up: a refused connection is the only "not yet".
 */
async function run(ctx: AdapterContext): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  const exec = ctx.exec ?? nodeExec;
  const resolvedVersion = await resolveVersion(ctx);
  const spec = `mcpo@${resolvedVersion ?? 'latest'}`;
  const port = await getFreePort();
  const defaults = defaultsInForce(ctx.mcpoWith);
  if (defaults.length > 0) {
    ctx.log(
      `mcpo: default constraints ${defaults.join(', ')} (a --mcpo-with entry for the same package replaces its default)`,
    );
  }
  ctx.log(`mcpo: running ${spec}, proxy on :${port}`);

  const proc = exec.spawn('uvx', uvxArgs(ctx, spec, defaults, port), { cwd: ctx.workDir });

  const finish = (partial: Omit<AdapterRunResult, 'adapter' | 'durationMs' | 'resolvedVersion'>) =>
    ({
      adapter: 'mcpo',
      durationMs: Date.now() - startedAt,
      resolvedVersion,
      ...partial,
    }) satisfies AdapterRunResult;
  const failed = (status: AdapterRunResult['status'], statusDetail: string) =>
    finish({ canary: null, status, statusDetail, surface: null });

  try {
    const openapiUrl = `http://127.0.0.1:${port}/openapi.json`;
    const served = Promise.withResolvers<FetchJsonResult>();
    const failure = await waitForReady({
      failFast: () => (proc.hasExited() ? 'mcpo exited before becoming ready' : null),
      intervalMs: 500,
      // A refused connection throws, which keeps the wait going.
      probe: async () => {
        served.resolve(await fetchJson(openapiUrl, { timeoutMs: 5_000 }));
        return true;
      },
      timeoutMs: ctx.timeoutMs,
    });
    if (failure !== null) {
      return proc.hasExited()
        ? failed('adapter-broken', exitedDetail(ctx, await proc.exited, proc.stderrTail()))
        : failed('handshake-failure', failure);
    }
    // Ready means the probe resolved this.
    const response = await served.promise;
    if (!response.ok) {
      return failed(
        'handshake-failure',
        excerpt(ctx.redact(`openapi.json returned HTTP ${response.status} — ${response.text}`)),
      );
    }
    const surface = surfaceFromOpenApiDoc(response.body);
    if (surface === null) {
      return failed(
        'capture-failure',
        `openapi.json was not an OpenAPI document (${Buffer.byteLength(response.text)} bytes)`,
      );
    }

    if (ctx.artifactsDir !== null) {
      await writeFile(
        join(ctx.artifactsDir, 'mcpo.openapi.json'),
        JSON.stringify(response.body, null, 2),
      );
    }

    const canary = await runCanary(ctx, port);
    return finish({ canary, status: 'ok', statusDetail: null, surface });
  } finally {
    proc.kill();
  }
}

/** mcpo (open-webui) — OpenAPI proxy rendering, stdio and streamable-http. */
export const mcpoAdapter: Adapter = {
  name: 'mcpo',
  optIn: false,
  run,
  supports: (_target: TargetSpec) => true,
};
