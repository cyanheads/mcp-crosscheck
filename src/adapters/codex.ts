/**
 * @file src/adapters/codex.ts
 * Codex CLI adapter (opt-in), via provider intercept: run `codex exec` under a
 * throwaway CODEX_HOME whose model provider points at the loopback intercept
 * (src/adapters/model-intercept.ts). Codex's first Responses API request
 * carries its converted `tools` array — Codex's exact rendered view of the MCP
 * server — before any model reply matters. No login, nothing reaches OpenAI,
 * zero tokens. The moment a tools-bearing request is captured, the Codex
 * process is torn down.
 *
 * Every npx call in a run names one exact spec, so the release reported is the
 * release that ran: a `--version` prime installs it into the caller's npm
 * cache, and the launch reads that cache through `npm_config_cache` while its
 * `HOME` and `CODEX_HOME` stay throwaway.
 *
 * Codex ships no native introspection (`codex mcp` has list/get/add/remove
 * only), so the intercept is the read path; a future `codex mcp tools --json`
 * upstream would replace it.
 */
import { createHash } from 'node:crypto';
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
import { excerpt, nodeExec } from '../util/exec.js';
import { npmLatestVersion } from '../util/versions.js';
import { interceptModelRequest } from './model-intercept.js';

/** Config key for the target server inside the throwaway CODEX_HOME. */
const SERVER_KEY = 'target';
const PACKAGE = '@openai/codex';
const VERSION_PATTERN = /\d+\.\d+\.\d+[^\s]*/;
const NO_MCP_TOOLS =
  'model request captured but it carried no MCP tools — the server may have failed to start under codex';

const CodexTool = z.object({
  description: z.string().optional(),
  name: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const CodexRequestBody = z.object({
  tools: z.array(z.unknown()).optional(),
});

/** JSON string escaping is valid TOML basic-string content for these values. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildConfigToml(target: AdapterTarget, port: number): string {
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
  ];
  if (target.kind === 'http') {
    lines.push(`url = ${tomlString(target.url)}`);
    const headerEntries = Object.keys(target.headers ?? {}).map(
      (name, index) => [name, `MCP_CROSSCHECK_TARGET_HEADER_${index}`] as const,
    );
    if (headerEntries.length > 0) {
      lines.push(
        `env_http_headers = { ${headerEntries
          .map(([name, envName]) => `${tomlString(name)} = ${tomlString(envName)}`)
          .join(', ')} }`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
  // The launcher command line: the target's environment lives in its spec file, not here.
  lines.push(
    `command = ${tomlString(target.command)}`,
    `args = [${target.args.map(tomlString).join(', ')}]`,
  );
  return `${lines.join('\n')}\n`;
}

/** A captured body's MCP tools, plus a label for each MCP entry that could not be read. */
interface CodexCapture {
  tools: RenderedTool[];
  unreadable: string[];
}

function renderCodexTool(name: string, tool: z.infer<typeof CodexTool>): RenderedTool {
  return renderedToolFromJsonSchema(name, tool.description ?? null, tool.parameters ?? {});
}

/**
 * Read Codex's MCP entries out of a captured request body: tools under a
 * namespace wrapper (`{type: "namespace", name: "mcp__<server>", tools: [...]}`,
 * current as of codex-cli 0.147.0), and the older flat `mcp__<server>__<tool>`
 * function-name form. An entry selected by those names that does not parse is
 * listed, never skipped. Null for a body without a `tools` array.
 */
function readCodexBody(body: unknown): CodexCapture | null {
  const parsed = CodexRequestBody.safeParse(body);
  if (!parsed.success || parsed.data.tools === undefined) return null;

  const capture: CodexCapture = { tools: [], unreadable: [] };
  const flatPrefix = `mcp__${SERVER_KEY}__`;
  for (const entry of parsed.data.tools) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue;
    if (entry.type === 'namespace' && entry.name.startsWith('mcp__')) {
      const namespace = JSON.stringify(entry.name);
      if (!Array.isArray(entry.tools)) {
        capture.unreadable.push(`${namespace} (its tools are not a list)`);
        continue;
      }
      for (const [index, rawTool] of entry.tools.entries()) {
        const tool = CodexTool.safeParse(rawTool);
        if (tool.success) {
          capture.tools.push(renderCodexTool(tool.data.name, tool.data));
        } else {
          capture.unreadable.push(
            isRecord(rawTool) && typeof rawTool.name === 'string'
              ? `${namespace} tool ${JSON.stringify(rawTool.name)}`
              : `${namespace} entry ${index}`,
          );
        }
      }
      continue;
    }
    if (entry.name.startsWith(flatPrefix)) {
      const tool = CodexTool.safeParse(entry);
      if (tool.success) {
        capture.tools.push(renderCodexTool(tool.data.name.slice(flatPrefix.length), tool.data));
      } else {
        capture.unreadable.push(JSON.stringify(entry.name));
      }
    }
  }
  return capture;
}

/**
 * Extract Codex's rendered MCP tools from a captured request body: the
 * namespace wrapper and the older flat `mcp__<server>__<tool>` form. Entries
 * that do not parse are left out. Null when no MCP tool parsed.
 */
export function surfaceFromCodexBody(body: unknown): RenderedSurface | null {
  const capture = readCodexBody(body);
  return capture === null || capture.tools.length === 0 ? null : { tools: capture.tools };
}

/** The model-visible namespace Codex gives the one configured server. */
const NAMESPACE = `mcp__${SERVER_KEY}`;
/** Codex's bound on `namespace + "__" + name`, in bytes; every name it measures here is ASCII. */
const MAX_TOOL_NAME_LENGTH = 128;
const DELIMITER_LENGTH = '__'.length;
const HASH_LENGTH = 12;

/** One advertised tool on its way through Codex's rename. */
interface CodexCandidate {
  hashed: boolean;
  /** Codex's raw tool identity for a stdio tool: server, namespace, connector, callable name, name. */
  identity: string;
  /** `identity` as UTF-8, which Codex sorts by byte. */
  identityBytes: Buffer;
  name: string;
  raw: string;
}

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

/** `sanitize_responses_api_tool_name`: each Unicode scalar outside `[A-Za-z0-9_]` becomes `_`. */
function sanitizeCodexName(name: string): string {
  let sanitized = '';
  // `for…of` walks Unicode scalars, as Rust's `chars()` does; an astral one is two units, one `_`.
  for (const character of name) {
    sanitized +=
      character.length === 1 && isAsciiWordCode(character.charCodeAt(0)) ? character : '_';
  }
  return sanitized === '' ? '_' : sanitized;
}

function hashSuffix(input: string): string {
  return `_${createHash('sha1').update(input, 'utf8').digest('hex').slice(0, HASH_LENGTH)}`;
}

/**
 * `fit_callable_parts_with_hash`: cut the name to leave room for a hash
 * suffix. Codex shortens the namespace instead only when the namespace alone
 * leaves no room for the suffix, which never holds for `mcp__target`.
 */
function fitWithHash(name: string, hashInput: string): string {
  const suffix = hashSuffix(hashInput);
  const maxToolLength = MAX_TOOL_NAME_LENGTH - (NAMESPACE.length + DELIMITER_LENGTH);
  return `${name.slice(0, maxToolLength - suffix.length)}${suffix}`;
}

/**
 * Codex's rename of the configured server's tools, a port of
 * `normalize_tools_for_model_with_prefix` (codex-rs/codex-mcp/src/tools.rs,
 * rust-v0.169.0) for the one stdio or HTTP server keyed `target`. Each name is
 * sanitized; every member of a group of names that sanitize alike gets
 * `_<12 hex of sha1(raw identity)>`; then, in byte order of raw identity, a
 * name that does not fit 128 bytes beside the namespace, or that an earlier
 * tool already took, is cut and hashed instead, with an attempt counter in the
 * hash input until it is unique. A repeated name is one tool. Pure.
 */
export function codexToolRenames(groundTruthNames: readonly string[]): ToolRenameMap {
  const candidates = new Map<string, CodexCandidate>();
  for (const raw of groundTruthNames) {
    if (candidates.has(raw)) continue;
    const identity = `${SERVER_KEY}\0${SERVER_KEY}\0\0${raw}\0${raw}`;
    candidates.set(raw, {
      hashed: false,
      identity,
      identityBytes: Buffer.from(identity, 'utf8'),
      name: sanitizeCodexName(raw),
      raw,
    });
  }

  const groupSizes = new Map<string, number>();
  for (const candidate of candidates.values()) {
    groupSizes.set(candidate.name, (groupSizes.get(candidate.name) ?? 0) + 1);
  }
  for (const candidate of candidates.values()) {
    if ((groupSizes.get(candidate.name) ?? 0) > 1) {
      candidate.name += hashSuffix(candidate.identity);
      candidate.hashed = true;
    }
  }

  const used = new Set<string>();
  const renames = new Map<string, ToolRename>();
  const ordered = [...candidates.values()].sort((left, right) =>
    Buffer.compare(left.identityBytes, right.identityBytes),
  );
  for (const candidate of ordered) {
    let rendered = candidate.name;
    const fits = NAMESPACE.length + rendered.length + DELIMITER_LENGTH <= MAX_TOOL_NAME_LENGTH;
    if (!fits || used.has(rendered)) {
      for (let attempt = 0; ; attempt += 1) {
        rendered = fitWithHash(
          candidate.name,
          attempt === 0 ? candidate.identity : `${candidate.identity}\0${attempt}`,
        );
        if (!used.has(rendered)) break;
      }
      candidate.hashed = true;
    }
    used.add(rendered);
    if (rendered !== candidate.raw) {
      renames.set(candidate.raw, {
        change: candidate.hashed ? 'hashed' : 'sanitized',
        kind: 'renamed',
        rendered,
      });
    }
  }
  return renames;
}

/** An npx that never started: a missing npx is named with what provides it; anything else keeps the spawn error. */
function notStartedDetail(code: string, text: string, redact: (text: string) => string): string {
  const error = excerpt(redact(text));
  const shown = error === '' ? `spawn failed with ${code}` : error;
  return code === 'ENOENT'
    ? `codex could not start — npx is not on PATH; it ships with npm, part of Node.js (${shown})`
    : `codex could not start — ${shown}`;
}

async function run(ctx: AdapterContext): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  const target = ctx.target;
  const exec = ctx.exec ?? nodeExec;

  const pin = ctx.pins.codex;
  const registryVersion =
    pin === undefined ? await npmLatestVersion(PACKAGE, ctx.workDir, exec) : null;
  const spec = `${PACKAGE}@${pin ?? registryVersion ?? 'latest'}`;
  // The run's one install: the prime fetches `spec` into the caller's npm cache, where the launch finds it.
  const prime = await exec.capture('npx', ['-y', spec, '--version'], {
    cwd: ctx.workDir,
    timeoutMs: Math.min(ctx.timeoutMs, 180_000),
  });
  const resolvedVersion =
    pin ?? registryVersion ?? prime.stdout.trim().match(VERSION_PATTERN)?.[0] ?? null;

  const finish = (partial: Omit<AdapterRunResult, 'adapter' | 'durationMs' | 'resolvedVersion'>) =>
    ({
      adapter: 'codex',
      durationMs: Date.now() - startedAt,
      resolvedVersion,
      ...partial,
    }) satisfies AdapterRunResult;
  const broken = (statusDetail: string) =>
    finish({ canary: null, status: 'adapter-broken', statusDetail, surface: null });

  if (prime.spawnErrorCode !== undefined) {
    return broken(notStartedDetail(prime.spawnErrorCode, prime.stderr, ctx.redact));
  }
  const cache = await exec.capture('npm', ['config', 'get', 'cache'], {
    cwd: ctx.workDir,
    timeoutMs: Math.min(ctx.timeoutMs, 30_000),
  });
  const npmCache = cache.stdout.trim();
  if (cache.code !== 0 || npmCache === '') {
    const shown = excerpt(ctx.redact(cache.stderr === '' ? cache.stdout : cache.stderr));
    return broken(
      `could not read npm's cache directory with npm config get cache — ${
        shown !== ''
          ? shown
          : cache.timedOut
            ? `npm config get cache timed out after ${Math.min(ctx.timeoutMs, 30_000)}ms`
            : `npm config get cache exited with code ${cache.code} and printed nothing`
      }`,
    );
  }

  const path = process.env.PATH;
  if (path === undefined || path === '') {
    return broken('PATH is required to launch the codex package runner');
  }
  const headerEnvironment =
    target.kind === 'http'
      ? Object.fromEntries(
          Object.values(target.headers ?? {}).map((value, index) => [
            `MCP_CROSSCHECK_TARGET_HEADER_${index}`,
            value,
          ]),
        )
      : {};
  const codexHome = await mkdtemp(join(ctx.workDir, 'codex-home-'));
  const outcome = await interceptModelRequest({
    launch: async (port) => {
      await writeFile(join(codexHome, 'config.toml'), buildConfigToml(target, port));
      ctx.log(`codex: resolved ${resolvedVersion ?? 'unknown version'}, intercept on :${port}`);
      return exec.spawn('npx', ['-y', spec, 'exec', '--skip-git-repo-check', 'ping'], {
        cwd: ctx.workDir,
        env: {
          CODEX_HOME: codexHome,
          HOME: codexHome,
          ...headerEnvironment,
          NO_PROXY: '*',
          PATH: path,
          npm_config_cache: npmCache,
        },
        inheritEnv: false,
      });
    },
    reply: () => ({ body: '{}', status: 200 }),
    timeoutMs: ctx.timeoutMs,
  });

  if (outcome.kind === 'exited') {
    const { spawnErrorCode } = outcome.exit;
    return broken(
      spawnErrorCode === undefined
        ? `codex exited before issuing a model request — ${excerpt(ctx.redact(outcome.stderrTail))}`
        : notStartedDetail(spawnErrorCode, outcome.stderrTail, ctx.redact),
    );
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

  const capture = readCodexBody(outcome.body) ?? { tools: [], unreadable: [] };
  const count = capture.unreadable.length;
  if (count > 0) {
    return finish({
      canary: null,
      status: 'capture-failure',
      statusDetail: `model request captured but ${count} MCP tool ${count === 1 ? 'entry' : 'entries'} in it could not be read: ${capture.unreadable.join(', ')}`,
      surface: null,
    });
  }
  const canary = { attempted: false, detail: 'codex adapter is capture-only', ok: null };
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

/** Codex CLI — provider-intercept capture of the converted tool surface. Opt-in. */
export const codexAdapter: Adapter = {
  name: 'codex',
  optIn: true,
  run,
  supports: (_target: TargetSpec) => true,
  toolRenames: codexToolRenames,
};
