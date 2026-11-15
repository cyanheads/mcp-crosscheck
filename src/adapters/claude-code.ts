/**
 * @file src/adapters/claude-code.ts
 * Claude Code adapter (opt-in), via Anthropic base-URL intercept. Runs the
 * installed `claude` executable with isolated user/config directories, one
 * explicit stdio MCP server, dummy auth, and the loopback model endpoint
 * (src/adapters/model-intercept.ts). The first tools-bearing request is the
 * converted tool surface; no model reply is required and no request leaves
 * loopback.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { isRecord, renderedToolFromJsonSchema } from '../schema.js';
import type {
  Adapter,
  AdapterContext,
  AdapterRunResult,
  AdapterTarget,
  RenderedSurface,
  RenderedTool,
  TargetSpec,
  ToolRename,
  ToolRenameMap,
} from '../types.js';
import { type Exec, excerpt, nodeExec } from '../util/exec.js';
import { interceptModelRequest } from './model-intercept.js';

/** Config key for the target server inside the isolated MCP configuration. */
const SERVER_KEY = 'target';
const NO_MCP_TOOLS =
  'tools-bearing model request captured but it carried no MCP tools for the configured target';

const ClaudeCodeTool = z.object({
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  name: z.string(),
});

const ClaudeCodeRequestBody = z.object({
  tools: z.array(z.unknown()).optional(),
});

/** A captured body's MCP tools for one server, plus the name of each of its entries that could not be read. */
interface ClaudeCodeCapture {
  tools: RenderedTool[];
  unreadable: string[];
}

/**
 * Read the `mcp__<server>__<tool>` entries out of a captured request body.
 * An entry with that prefix that does not parse is listed, never skipped.
 * Null for a body without a `tools` array.
 */
function readClaudeCodeBody(body: unknown, serverKey: string): ClaudeCodeCapture | null {
  const parsed = ClaudeCodeRequestBody.safeParse(body);
  if (!parsed.success || parsed.data.tools === undefined) return null;

  const prefix = `mcp__${serverKey}__`;
  const capture: ClaudeCodeCapture = { tools: [], unreadable: [] };
  for (const entry of parsed.data.tools) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.startsWith(prefix)) {
      continue;
    }
    const tool = ClaudeCodeTool.safeParse(entry);
    if (!tool.success) {
      capture.unreadable.push(JSON.stringify(entry.name));
      continue;
    }
    capture.tools.push(
      renderedToolFromJsonSchema(
        tool.data.name.slice(prefix.length),
        tool.data.description ?? null,
        tool.data.input_schema ?? {},
      ),
    );
  }
  return capture;
}

/** Extract exact `mcp__<server>__<tool>` entries from a Claude Code model request; unparseable ones are left out. */
export function surfaceFromClaudeCodeBody(
  body: unknown,
  serverKey = SERVER_KEY,
): RenderedSurface | null {
  const capture = readClaudeCodeBody(body, serverKey);
  return capture === null || capture.tools.length === 0 ? null : { tools: capture.tools };
}

/** The prefix Claude Code puts on each of the configured server's tool names. */
const TOOL_PREFIX = `mcp__${SERVER_KEY}__`;
/** The longest prefixed tool name Claude Code sends, in UTF-16 code units. */
const MAX_TOOL_NAME_LENGTH = 128;
const SPECIAL_PREFIX = 'claude.ai ';

function isNameCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2d
  );
}

/**
 * Claude Code's tool-name rule (2.1.325): each UTF-16 code unit outside
 * `[a-zA-Z0-9_-]` becomes `_`; a name beginning `claude.ai ` also has its
 * underscore runs collapsed to one and trimmed from both ends. One pass,
 * deciding each unit from the output so far.
 */
function claudeCodeToolName(name: string): string {
  const special = name.startsWith(SPECIAL_PREFIX);
  let rendered = '';
  for (let index = 0; index < name.length; index += 1) {
    const unit = isNameCode(name.charCodeAt(index)) ? (name[index] as string) : '_';
    if (special && unit === '_' && (rendered === '' || rendered.endsWith('_'))) continue;
    rendered += unit;
  }
  return special && rendered.endsWith('_') ? rendered.slice(0, -1) : rendered;
}

/**
 * Claude Code's rename of the configured server's tools, keyed on the server
 * key `target`. Names are sanitized (`claudeCodeToolName`); a name whose
 * prefixed form passes 128 code units is dropped; of names that render alike,
 * the first in `tools/list` order is kept and the rest are dropped. A repeated
 * name is one tool. Pure.
 */
export function claudeCodeToolRenames(groundTruthNames: readonly string[]): ToolRenameMap {
  const renames = new Map<string, ToolRename>();
  const seen = new Set<string>();
  /** Rendered name → the advertised name that took it. */
  const taken = new Map<string, string>();
  for (const raw of groundTruthNames) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const rendered = claudeCodeToolName(raw);
    const length = TOOL_PREFIX.length + rendered.length;
    if (length > MAX_TOOL_NAME_LENGTH) {
      renames.set(raw, {
        kind: 'dropped',
        reason: `its rendered name ${JSON.stringify(TOOL_PREFIX + rendered)} is ${length} characters, and Claude Code sends none longer than ${MAX_TOOL_NAME_LENGTH}`,
      });
      continue;
    }
    const holder = taken.get(rendered);
    if (holder !== undefined) {
      renames.set(raw, {
        kind: 'dropped',
        reason: `${JSON.stringify(holder)}, listed before it, also renders as ${JSON.stringify(rendered)}, and Claude Code keeps only the first`,
      });
      continue;
    }
    taken.set(rendered, raw);
    if (rendered !== raw) renames.set(raw, { change: 'sanitized', kind: 'renamed', rendered });
  }
  return renames;
}

function buildMcpConfig(target: Extract<AdapterTarget, { kind: 'stdio' }>): string {
  // The launcher command line: the target's environment lives in its spec file, not here.
  return `${JSON.stringify(
    {
      mcpServers: {
        [SERVER_KEY]: { args: target.args, command: target.command, type: 'stdio' },
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
  if (result.spawnErrorCode === 'ENOENT') {
    return {
      error: `the claude-code adapter needs a claude executable on PATH; on Windows an npm global install provides only claude.cmd, which cannot launch without a shell, so use the native installer's claude.exe (${excerpt(ctx.redact(result.stderr))})`,
      version: null,
    };
  }
  const version = `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+\.\d+[^\s]*/)?.[0] ?? null;
  if (result.code === 0 && !result.timedOut && version !== null) {
    return { error: null, version };
  }
  const detail = excerpt(ctx.redact(result.stderr === '' ? result.stdout : result.stderr));
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

  const isolatedHome = await mkdtemp(join(ctx.workDir, 'claude-home-'));
  const configDir = await mkdtemp(join(ctx.workDir, 'claude-config-'));
  const configPath = join(configDir, 'mcp.json');
  await writeFile(configPath, buildMcpConfig(target));

  const outcome = await interceptModelRequest({
    launch: (port) => {
      ctx.log(`claude-code: installed ${resolved.version}, intercept on :${port}`);
      return exec.spawn(
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
    },
    reply: ({ method, url }) =>
      method === 'HEAD' && url === '/api/hello'
        ? { status: 200 }
        : {
            body: JSON.stringify({
              error: { message: 'mcp-crosscheck capture complete', type: 'auth_error' },
            }),
            status: 401,
          },
    timeoutMs: ctx.timeoutMs,
  });

  if (outcome.kind === 'exited') {
    const detail = excerpt(ctx.redact(outcome.stderrTail));
    const { code, spawnErrorCode } = outcome.exit;
    return finish({
      canary: null,
      status: 'adapter-broken',
      statusDetail:
        spawnErrorCode === undefined
          ? `claude exited before issuing a tools-bearing model request — ${
              detail === '' ? `exit code ${code}` : detail
            }`
          : `claude could not start — ${detail === '' ? `spawn failed with ${spawnErrorCode}` : detail}`,
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

  const capture = readClaudeCodeBody(outcome.body, SERVER_KEY) ?? { tools: [], unreadable: [] };
  const count = capture.unreadable.length;
  if (count > 0) {
    return finish({
      canary: null,
      status: 'capture-failure',
      statusDetail: `tools-bearing model request captured but ${count} MCP tool ${count === 1 ? 'entry' : 'entries'} for the configured target could not be read: ${capture.unreadable.join(', ')}`,
      surface: null,
    });
  }
  const canary = { attempted: false, detail: 'claude-code adapter is capture-only', ok: null };
  if (capture.tools.length === 0) {
    return finish({
      canary,
      emptyCapture: { detail: NO_MCP_TOOLS },
      status: 'ok',
      statusDetail: null,
      surface: { tools: [] },
    });
  }
  return finish({ canary, status: 'ok', statusDetail: null, surface: { tools: capture.tools } });
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
  toolRenames: claudeCodeToolRenames,
};
