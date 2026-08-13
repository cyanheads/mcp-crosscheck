/**
 * @file src/adapters/claude-code.ts
 * Claude Code adapter (opt-in), via Anthropic base-URL intercept. Runs the
 * installed `claude` executable with isolated user/config directories, one
 * explicit stdio MCP server, dummy auth, and a loopback model endpoint. The
 * first tools-bearing request is the converted tool surface; no model reply is
 * required and no request leaves loopback.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';

import { z } from 'zod';

import { renderedToolFromJsonSchema } from '../schema.js';
import type {
  Adapter,
  AdapterContext,
  AdapterRunResult,
  RenderedSurface,
  RenderedTool,
  TargetSpec,
} from '../types.js';
import { type Exec, excerpt, type ManagedProcess, nodeExec } from '../util/exec.js';
import { getFreePort } from '../util/net.js';

/** Config key for the target server inside the isolated MCP configuration. */
const SERVER_KEY = 'target';

const ClaudeCodeTool = z.object({
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  name: z.string(),
});

const ClaudeCodeRequestBody = z.object({
  tools: z.array(z.unknown()).optional(),
});

/** Extract exact `mcp__<server>__<tool>` entries from a Claude Code model request. */
export function surfaceFromClaudeCodeBody(
  body: unknown,
  serverKey = SERVER_KEY,
): RenderedSurface | null {
  const parsed = ClaudeCodeRequestBody.safeParse(body);
  if (!parsed.success || parsed.data.tools === undefined) return null;

  const prefix = `mcp__${serverKey}__`;
  const rendered: RenderedTool[] = [];
  for (const entry of parsed.data.tools) {
    const tool = ClaudeCodeTool.safeParse(entry);
    if (!tool.success || !tool.data.name.startsWith(prefix)) continue;
    rendered.push(
      renderedToolFromJsonSchema(
        tool.data.name.slice(prefix.length),
        tool.data.description ?? null,
        tool.data.input_schema ?? {},
      ),
    );
  }
  return rendered.length > 0 ? { tools: rendered } : null;
}

interface CaptureServer {
  captured: Promise<unknown>;
  close: () => Promise<void>;
}

/** Loopback Anthropic stub; resolves on the first request carrying a non-empty tools array. */
function startCaptureServer(port: number): Promise<CaptureServer> {
  let resolveCaptured: (body: unknown) => void;
  let didCapture = false;
  const captured = new Promise<unknown>((resolve) => {
    resolveCaptured = resolve;
  });
  const server = http.createServer((request, response) => {
    if (request.method === 'HEAD' && request.url === '/api/hello') {
      response.writeHead(200).end();
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !didCapture &&
          typeof body === 'object' &&
          body !== null &&
          'tools' in body &&
          Array.isArray(body.tools) &&
          body.tools.length > 0
        ) {
          didCapture = true;
          resolveCaptured(body);
        }
      } catch {
        /* non-JSON requests cannot carry a rendered tool surface */
      }
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: 'mcp-crosscheck capture complete', type: 'auth_error' },
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        captured,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function buildMcpConfig(target: Extract<TargetSpec, { kind: 'stdio' }>): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [SERVER_KEY]: {
          args: target.args,
          command: target.command,
          ...(Object.keys(target.env).length === 0 ? {} : { env: target.env }),
          type: 'stdio',
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function installedVersion(
  ctx: AdapterContext,
  exec: Exec,
): Promise<{ error: string | null; version: string | null }> {
  const result = await exec.capture('claude', ['--version'], {
    cwd: ctx.workDir,
    timeoutMs: Math.min(ctx.timeoutMs, 30_000),
  });
  const version = `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+\.\d+[^\s]*/)?.[0] ?? null;
  if (result.code === 0 && !result.timedOut && version !== null) {
    return { error: null, version };
  }
  const detail = excerpt(result.stderr === '' ? result.stdout : result.stderr);
  return {
    error: result.timedOut
      ? `claude --version timed out after ${Math.min(ctx.timeoutMs, 30_000)}ms`
      : detail === ''
        ? `claude --version exited with code ${result.code}`
        : detail,
    version,
  };
}

async function run(ctx: AdapterContext): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  if (ctx.target.kind !== 'stdio') {
    throw new Error('claude-code adapter supports stdio targets only');
  }
  const target = ctx.target;
  const exec = ctx.exec ?? nodeExec;
  const resolved = await installedVersion(ctx, exec);

  const finish = (partial: Omit<AdapterRunResult, 'adapter' | 'durationMs' | 'resolvedVersion'>) =>
    ({
      adapter: 'claude-code',
      durationMs: Date.now() - startedAt,
      resolvedVersion: resolved.version,
      ...partial,
    }) satisfies AdapterRunResult;

  if (resolved.error !== null) {
    return finish({
      canary: null,
      status: 'adapter-broken',
      statusDetail: `installed Claude Code is unavailable — ${resolved.error}`,
      surface: null,
    });
  }

  const pin = ctx.pins['claude-code'];
  if (pin !== undefined && pin !== resolved.version) {
    return finish({
      canary: null,
      status: 'adapter-broken',
      statusDetail: `installed Claude Code ${resolved.version} does not match requested pin ${pin}`,
      surface: null,
    });
  }

  const path = process.env.PATH;
  if (path === undefined || path === '') {
    return finish({
      canary: null,
      status: 'adapter-broken',
      statusDetail: 'PATH is required to launch the installed Claude Code client and stdio target',
      surface: null,
    });
  }

  const port = await getFreePort();
  const isolatedHome = await mkdtemp(join(ctx.workDir, 'claude-home-'));
  const configDir = await mkdtemp(join(ctx.workDir, 'claude-config-'));
  const configPath = join(configDir, 'mcp.json');
  await writeFile(configPath, buildMcpConfig(target));
  ctx.log(`claude-code: installed ${resolved.version}, intercept on :${port}`);

  const capture = await startCaptureServer(port);
  let proc: ManagedProcess | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    proc = exec.spawn(
      'claude',
      ['--bare', '--strict-mcp-config', '--mcp-config', configPath, '--print', 'ping'],
      {
        cwd: ctx.workDir,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-api03-mcp-crosscheck-dummy',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          CLAUDE_CONFIG_DIR: configDir,
          HOME: isolatedHome,
          NO_PROXY: '*',
          PATH: path,
        },
        inheritEnv: false,
      },
    );

    const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: 'timeout' }), ctx.timeoutMs);
    });
    const outcome = await Promise.race([
      capture.captured.then((body) => ({ body, kind: 'captured' }) as const),
      proc.exited.then((exit) => ({ exit, kind: 'exited' }) as const),
      timeoutPromise,
    ]);

    if (outcome.kind === 'exited') {
      const detail = excerpt(proc.stderrTail());
      return finish({
        canary: null,
        status: 'adapter-broken',
        statusDetail: `claude exited before issuing a tools-bearing model request — ${
          detail === '' ? `exit code ${outcome.exit.code}` : detail
        }`,
        surface: null,
      });
    }
    if (outcome.kind === 'timeout') {
      return finish({
        canary: null,
        status: 'handshake-failure',
        statusDetail: `no tools-bearing model request captured within ${ctx.timeoutMs}ms`,
        surface: null,
      });
    }

    if (ctx.artifactsDir !== null) {
      await writeFile(
        join(ctx.artifactsDir, 'claude-code.request.json'),
        JSON.stringify(outcome.body, null, 2),
      );
    }

    const surface = surfaceFromClaudeCodeBody(outcome.body);
    if (surface === null) {
      return finish({
        canary: null,
        status: 'handshake-failure',
        statusDetail:
          'tools-bearing model request captured but it carried no MCP tools for the configured target',
        surface: null,
      });
    }
    return finish({
      canary: { attempted: false, detail: 'claude-code adapter is capture-only', ok: null },
      status: 'ok',
      statusDetail: null,
      surface,
    });
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    proc?.kill();
    await capture.close();
  }
}

/** Claude Code — installed-client loopback capture of converted input schemas. Opt-in. */
export const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  optIn: true,
  run,
  supports: (target: TargetSpec) =>
    target.kind === 'stdio'
      ? true
      : 'claude-code adapter supports stdio targets only in this release',
};
