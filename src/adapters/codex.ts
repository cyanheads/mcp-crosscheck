/**
 * @file src/adapters/codex.ts
 * Codex CLI adapter (opt-in), via provider intercept: run `codex exec` under a
 * throwaway CODEX_HOME whose model provider points at a local capture server.
 * Codex's first Responses API request carries its converted `tools` array —
 * Codex's exact rendered view of the MCP server — before any model reply
 * matters. No login, nothing reaches OpenAI, zero tokens. The moment a
 * tools-bearing request is captured, the Codex process is torn down.
 *
 * Codex ships no native introspection (`codex mcp` has list/get/add/remove
 * only), so the intercept is the read path; a future `codex mcp tools --json`
 * upstream would replace it.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';

import { z } from 'zod';

import { isRecord, renderedToolFromJsonSchema } from '../schema.js';
import type {
  Adapter,
  AdapterContext,
  AdapterRunResult,
  RenderedSurface,
  RenderedTool,
  TargetSpec,
} from '../types.js';
import { type Exec, excerpt, nodeExec } from '../util/exec.js';
import { getFreePort } from '../util/net.js';
import { npmLatestVersion } from '../util/versions.js';

/** Config key for the target server inside the throwaway CODEX_HOME. */
const SERVER_KEY = 'target';

const CodexTool = z.object({
  description: z.string().optional(),
  name: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const CodexRequestBody = z.object({
  tools: z.array(z.unknown()).optional(),
});

function packageSpec(ctx: AdapterContext): string {
  const pin = ctx.pins.codex;
  return pin === undefined ? '@openai/codex' : `@openai/codex@${pin}`;
}

/** JSON string escaping is valid TOML basic-string content for these values. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildConfigToml(target: Extract<TargetSpec, { kind: 'stdio' }>, port: number): string {
  const lines = [
    'model = "crosscheck-stub"',
    'model_provider = "crosscheck"',
    '',
    '[model_providers.crosscheck]',
    'name = "mcp-crosscheck local intercept"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    '',
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(target.command)}`,
    `args = [${target.args.map(tomlString).join(', ')}]`,
  ];
  const envEntries = Object.entries(target.env);
  if (envEntries.length > 0) {
    lines.push('', `[mcp_servers.${SERVER_KEY}.env]`);
    for (const [key, value] of envEntries) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Extract Codex's rendered MCP tools from a captured request body. Handles the
 * namespace wrapper (`{type: "namespace", name: "mcp__<server>", tools: [...]}`,
 * current as of codex-cli 0.147.0) and the older flat `mcp__<server>__<tool>`
 * function-name form.
 */
export function surfaceFromCodexBody(body: unknown): RenderedSurface | null {
  const parsed = CodexRequestBody.safeParse(body);
  if (!parsed.success || parsed.data.tools === undefined) return null;

  const rendered: RenderedTool[] = [];
  for (const entry of parsed.data.tools) {
    if (!isRecord(entry)) continue;
    if (
      entry.type === 'namespace' &&
      typeof entry.name === 'string' &&
      entry.name.startsWith('mcp__')
    ) {
      const nested = Array.isArray(entry.tools) ? entry.tools : [];
      for (const rawTool of nested) {
        const tool = CodexTool.safeParse(rawTool);
        if (!tool.success) continue;
        rendered.push(
          renderedToolFromJsonSchema(
            tool.data.name,
            tool.data.description ?? null,
            tool.data.parameters ?? {},
          ),
        );
      }
      continue;
    }
    const flatPrefix = `mcp__${SERVER_KEY}__`;
    if (typeof entry.name === 'string' && entry.name.startsWith(flatPrefix)) {
      const tool = CodexTool.safeParse(entry);
      if (!tool.success) continue;
      rendered.push(
        renderedToolFromJsonSchema(
          tool.data.name.slice(flatPrefix.length),
          tool.data.description ?? null,
          tool.data.parameters ?? {},
        ),
      );
    }
  }
  return rendered.length > 0 ? { tools: rendered } : null;
}

interface CaptureServer {
  captured: Promise<unknown>;
  close: () => void;
}

/** Local HTTP stub standing in for the model provider; resolves on the first tools-bearing POST. */
function startCaptureServer(port: number): Promise<CaptureServer> {
  let resolveCaptured: (body: unknown) => void;
  const captured = new Promise<unknown>((resolve) => {
    resolveCaptured = resolve;
  });
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (isRecord(body) && Array.isArray(body.tools) && body.tools.length > 0) {
          resolveCaptured(body);
        }
      } catch {
        /* not JSON — ignore */
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ captured, close: () => server.close() });
    });
  });
}

async function resolveVersion(ctx: AdapterContext, exec: Exec): Promise<string | null> {
  const pin = ctx.pins.codex;
  if (pin !== undefined) return pin;
  const result = await exec.capture('npx', ['-y', packageSpec(ctx), '--version'], {
    cwd: ctx.workDir,
    timeoutMs: Math.min(ctx.timeoutMs, 180_000),
  });
  const match = result.stdout.trim().match(/\d+\.\d+\.\d+[^\s]*/);
  if (match !== null) return match[0];
  return npmLatestVersion('@openai/codex', ctx.workDir, exec);
}

async function run(ctx: AdapterContext): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  if (ctx.target.kind !== 'stdio') {
    throw new Error('codex adapter supports stdio targets only');
  }
  const target = ctx.target;

  const exec = ctx.exec ?? nodeExec;
  const resolvedVersion = await resolveVersion(ctx, exec);
  const port = await getFreePort();
  const codexHome = await mkdtemp(join(ctx.workDir, 'codex-home-'));
  await writeFile(join(codexHome, 'config.toml'), buildConfigToml(target, port));
  ctx.log(`codex: resolved ${resolvedVersion ?? 'unknown version'}, intercept on :${port}`);

  const capture = await startCaptureServer(port);
  const proc = exec.spawn(
    'npx',
    ['-y', packageSpec(ctx), 'exec', '--skip-git-repo-check', 'ping'],
    {
      cwd: ctx.workDir,
      env: { CODEX_HOME: codexHome },
    },
  );

  const finish = (partial: Omit<AdapterRunResult, 'adapter' | 'durationMs' | 'resolvedVersion'>) =>
    ({
      adapter: 'codex',
      durationMs: Date.now() - startedAt,
      resolvedVersion,
      ...partial,
    }) satisfies AdapterRunResult;

  const capturedOnly = { attempted: false, detail: 'codex adapter is capture-only', ok: null };

  try {
    const outcome = await Promise.race([
      capture.captured.then((body) => ({ body, kind: 'captured' }) as const),
      proc.exited.then(() => ({ kind: 'exited' }) as const),
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), ctx.timeoutMs),
      ),
    ]);

    if (outcome.kind === 'exited') {
      return finish({
        canary: null,
        status: 'adapter-broken',
        statusDetail: `codex exited before issuing a model request — ${excerpt(proc.stderrTail())}`,
        surface: null,
      });
    }
    if (outcome.kind === 'timeout') {
      return finish({
        canary: null,
        status: 'handshake-failure',
        statusDetail: `no model request captured within ${ctx.timeoutMs}ms`,
        surface: null,
      });
    }

    if (ctx.artifactsDir !== null) {
      await writeFile(
        `${ctx.artifactsDir}/codex.request.json`,
        JSON.stringify(outcome.body, null, 2),
      );
    }

    const surface = surfaceFromCodexBody(outcome.body);
    if (surface === null) {
      return finish({
        canary: null,
        status: 'handshake-failure',
        statusDetail:
          'model request captured but it carried no MCP tools — the server may have failed to start under codex',
        surface: null,
      });
    }
    return finish({ canary: capturedOnly, status: 'ok', statusDetail: null, surface });
  } finally {
    proc.kill();
    capture.close();
  }
}

/** Codex CLI — provider-intercept capture of the converted tool surface. Opt-in. */
export const codexAdapter: Adapter = {
  name: 'codex',
  optIn: true,
  run,
  supports: (target: TargetSpec) =>
    target.kind === 'stdio' ? true : 'codex adapter supports stdio targets only in this release',
};
