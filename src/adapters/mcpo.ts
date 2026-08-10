/**
 * @file src/adapters/mcpo.ts
 * mcpo adapter (open-webui's MCP → OpenAPI proxy). Boots `uvx mcpo` against
 * the target, reads the generated openapi.json as the rendered surface, and
 * optionally round-trips the canary as a live POST. Requires `uv` on PATH.
 */
import { isRecord, renderedToolFromJsonSchema } from '../schema.js';
import type {
  Adapter,
  AdapterContext,
  AdapterRunResult,
  CanaryOutcome,
  RenderedSurface,
  RenderedTool,
  TargetSpec,
} from '../types.js';
import { excerpt, execCapture, spawnManaged } from '../util/exec.js';
import { fetchJson, getFreePort, waitForReady } from '../util/net.js';
import { pypiLatestVersion } from '../util/versions.js';

function packageSpec(ctx: AdapterContext): string {
  const pin = ctx.pins.mcpo;
  return pin === undefined ? 'mcpo' : `mcpo@${pin}`;
}

function uvxArgs(ctx: AdapterContext, port: number): string[] {
  const withFlags = ctx.mcpoWith.flatMap((constraint) => ['--with', constraint]);
  const base = [...withFlags, packageSpec(ctx), '--host', '127.0.0.1', '--port', String(port)];
  if (ctx.target.kind === 'http') {
    return [...base, '--server-type', 'streamable-http', '--', ctx.target.url];
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

  const requestBody = post.requestBody;
  if (!isRecord(requestBody)) {
    // No request body at all — an empty surface the invariant engine judges
    // against whether ground truth advertises input properties.
    return renderedToolFromJsonSchema(name, description, {}, doc);
  }
  const content = isRecord(requestBody.content) ? requestBody.content : {};
  const jsonContent = isRecord(content['application/json']) ? content['application/json'] : {};
  const schema = jsonContent.schema ?? {};
  return renderedToolFromJsonSchema(name, description, schema, doc);
}

async function resolveVersion(ctx: AdapterContext): Promise<string | null> {
  const pin = ctx.pins.mcpo;
  if (pin !== undefined) return pin;
  const withFlags = ctx.mcpoWith.flatMap((constraint) => ['--with', constraint]);
  const result = await execCapture('uvx', [...withFlags, packageSpec(ctx), '--version'], {
    cwd: ctx.workDir,
    timeoutMs: Math.min(ctx.timeoutMs, 120_000),
  });
  const match = `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+\.\d+[^\s]*/);
  if (match !== null) return match[0];
  return pypiLatestVersion('mcpo');
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
        detail: excerpt(`HTTP ${response.status} — ${response.text}`),
        ok: false,
      };
    }
    return { attempted: true, detail: null, ok: true };
  } catch (error) {
    return { attempted: true, detail: excerpt(String(error)), ok: false };
  }
}

async function run(ctx: AdapterContext): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  const resolvedVersion = await resolveVersion(ctx);
  const port = await getFreePort();
  ctx.log(`mcpo: resolved ${resolvedVersion ?? 'unknown version'}, proxy on :${port}`);

  const env = ctx.target.kind === 'stdio' ? ctx.target.env : {};
  const proc = spawnManaged('uvx', uvxArgs(ctx, port), { cwd: ctx.workDir, env });

  const finish = (partial: Omit<AdapterRunResult, 'adapter' | 'durationMs' | 'resolvedVersion'>) =>
    ({
      adapter: 'mcpo',
      durationMs: Date.now() - startedAt,
      resolvedVersion,
      ...partial,
    }) satisfies AdapterRunResult;

  try {
    const openapiUrl = `http://127.0.0.1:${port}/openapi.json`;
    const failure = await waitForReady({
      failFast: () =>
        proc.hasExited()
          ? `mcpo exited before becoming ready — ${excerpt(proc.stderrTail())}`
          : null,
      intervalMs: 500,
      probe: async () => (await fetchJson(openapiUrl, { timeoutMs: 5_000 })).ok,
      timeoutMs: ctx.timeoutMs,
    });
    if (failure !== null) {
      const broken = proc.hasExited();
      return finish({
        canary: null,
        status: broken ? 'adapter-broken' : 'handshake-failure',
        statusDetail: failure,
        surface: null,
      });
    }

    const response = await fetchJson(openapiUrl, { timeoutMs: 30_000 });
    const surface = surfaceFromOpenApiDoc(response.body);
    if (surface === null) {
      return finish({
        canary: null,
        status: 'handshake-failure',
        statusDetail: 'openapi.json was not parseable',
        surface: null,
      });
    }

    if (ctx.artifactsDir !== null) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        `${ctx.artifactsDir}/mcpo.openapi.json`,
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
