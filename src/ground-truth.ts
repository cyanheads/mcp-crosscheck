/**
 * @file src/ground-truth.ts
 * Captures the server's own advertised surface via the official MCP TypeScript
 * SDK client — the baseline every adapter's rendered surface is diffed against.
 *
 * `tools/list` is read through `client.request` with a permissive result
 * schema, not `client.listTools`. The SDK 1.x `Tool` schema rejects the whole
 * list over one tool it does not accept, such as a boolean property schema or
 * a non-object `outputSchema` root — both valid JSON Schema, and typical of
 * the servers whose rendering differs most between clients. Each tool it
 * rejects is captured anyway, with the rejection recorded on the tool.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type Tool, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type {
  CanaryOutcome,
  CanarySpec,
  GroundTruth,
  GroundTruthTool,
  GroundTruthTruncation,
  TargetSpec,
} from './types.js';
import { excerpt } from './util/exec.js';
import { VERSION } from './version.js';

const MAX_TOOL_PAGES = 100;

/**
 * One advertised tool, checked only for what ground truth needs: a string
 * name and object schemas. Every other key passes through untouched, so the
 * SDK 1.x check sees the tool exactly as the server sent it.
 */
const AdvertisedToolSchema = z.looseObject({
  inputSchema: z.record(z.string(), z.unknown()),
  name: z.string(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

type AdvertisedTool = z.infer<typeof AdvertisedToolSchema>;

const ToolListPageSchema = z.looseObject({
  nextCursor: z.string().optional(),
  tools: z.array(AdvertisedToolSchema),
});

function buildHttpTransport(target: Extract<TargetSpec, { kind: 'http' }>) {
  return new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: target.headers === undefined ? {} : { headers: target.headers },
  });
}

function buildTransport(target: TargetSpec): Transport {
  if (target.kind === 'http') {
    // Widening cast: the SDK is not compiled with exactOptionalPropertyTypes,
    // so its concrete transport's `sessionId: string | undefined` does not
    // satisfy the Transport interface under this project's stricter settings.
    return buildHttpTransport(target) as Transport;
  }
  return new StdioClientTransport({
    args: target.args,
    command: target.command,
    env: { ...getDefaultEnvironment(), ...target.env },
    stderr: 'ignore',
  });
}

/** One rejecting deadline shared by every stage of a ground-truth session. */
function sessionDeadline(timeoutMs: number): { cancel: () => void; expired: Promise<never> } {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ground-truth client timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return { cancel: () => clearTimeout(timer), expired };
}

/** Connect and explicitly terminate one HTTP session, exercising the SDK DELETE path. */
export async function terminateGroundTruthSession(
  target: Extract<TargetSpec, { kind: 'http' }>,
  timeoutMs: number,
): Promise<void> {
  const client = new Client({ name: 'mcp-crosscheck', version: VERSION });
  const transport = buildHttpTransport(target);
  const deadline = sessionDeadline(timeoutMs);
  try {
    await Promise.race([client.connect(transport as Transport), deadline.expired]);
    await Promise.race([transport.terminateSession(), deadline.expired]);
  } finally {
    deadline.cancel();
    await client.close().catch(() => {});
  }
}

async function withClient<T>(
  target: TargetSpec,
  timeoutMs: number,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: 'mcp-crosscheck', version: VERSION });
  const transport = buildTransport(target);
  const deadline = sessionDeadline(timeoutMs);
  try {
    await Promise.race([client.connect(transport), deadline.expired]);
    return await Promise.race([fn(client), deadline.expired]);
  } finally {
    deadline.cancel();
    await client.close().catch(() => {
      /* transport already gone */
    });
  }
}

/** How a `tools/list` walk ended. */
interface ToolListWalk<T> {
  /** What `visit` returned when it ended the walk; undefined when it never did. */
  found: T | undefined;
  pagesRead: number;
  /** Set when the walk stopped with a `nextCursor` it did not follow. */
  truncation: GroundTruthTruncation | null;
}

/**
 * Read `tools/list` one page at a time, handing each page to `visit`, until
 * `visit` returns a value, a page carries no `nextCursor`, a `nextCursor`
 * equals a cursor already sent, or `MAX_TOOL_PAGES` pages are read. The page
 * that ends the walk is always visited, and no page is requested twice.
 */
async function walkToolList<T>(
  client: Client,
  timeoutMs: number,
  visit: (tools: AdvertisedTool[]) => T | undefined,
): Promise<ToolListWalk<T>> {
  const sent = new Set<string>();
  let cursor: string | undefined;
  for (let pagesRead = 1; pagesRead <= MAX_TOOL_PAGES; pagesRead++) {
    const page = await client.request(
      { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
      ToolListPageSchema,
      { timeout: timeoutMs },
    );
    const found = visit(page.tools);
    if (found !== undefined || page.nextCursor === undefined) {
      return { found, pagesRead, truncation: null };
    }
    if (sent.has(page.nextCursor)) {
      return { found, pagesRead, truncation: { pagesRead, reason: 'cursor-repeated' } };
    }
    sent.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return {
    found: undefined,
    pagesRead: MAX_TOOL_PAGES,
    truncation: { pagesRead: MAX_TOOL_PAGES, reason: 'page-cap' },
  };
}

/** Schema issues as `<path>: <message>` entries, the path dotted from the tool's root. */
function rejectionEntries(
  issues: readonly { message: string; path: readonly PropertyKey[] }[],
): string[] {
  return issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);
}

function groundTruthTool(tool: AdvertisedTool): GroundTruthTool {
  const parsed = ToolSchema.safeParse(tool);
  const rejection = parsed.success ? [] : rejectionEntries(parsed.error.issues);
  return {
    description: typeof tool.description === 'string' ? tool.description : null,
    inputSchema: tool.inputSchema,
    name: tool.name,
    // Most tools advertise no result schema and pass the SDK check; the keys stay off those.
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(rejection.length === 0 ? {} : { sdkV1Rejection: rejection }),
  };
}

/** Connect with the official SDK client and capture serverInfo plus the paginated tool list. */
export function captureGroundTruth(target: TargetSpec, timeoutMs: number): Promise<GroundTruth> {
  return withClient(target, timeoutMs, async (client) => {
    const serverInfo = client.getServerVersion();
    const tools: GroundTruthTool[] = [];
    const { truncation } = await walkToolList(client, timeoutMs, (page) => {
      tools.push(...page.map(groundTruthTool));
      return;
    });
    return {
      serverName: serverInfo?.name ?? null,
      serverVersion: serverInfo?.version ?? null,
      tools,
      truncation,
    };
  });
}

/**
 * The SDK client's per-tool metadata cache, private in its typings. `listTools`
 * refills it from each page it parses, and `callTool` reads it to check
 * `structuredContent` against the tool's `outputSchema`. The canary lists
 * through the permissive walk instead, so it fills the cache with the one tool
 * it calls; `callTool` then applies its own checks exactly as after `listTools`.
 */
interface ToolMetadataCache {
  cacheToolMetadata(tools: Tool[]): void;
}

function canaryFailure(detail: string): CanaryOutcome {
  return { attempted: true, detail: excerpt(detail), ok: false };
}

/**
 * Call the canary tool the way an SDK client does: list `tools/list` up to the
 * page that advertises it, then call it before requesting another page, so the
 * SDK checks the result against the tool's `outputSchema`. This must succeed
 * before any adapter runs. A failure here comes from the canary spec or the
 * server itself, never from a client under test.
 */
export async function runGroundTruthCanary(
  target: TargetSpec,
  canary: CanarySpec,
  timeoutMs: number,
): Promise<CanaryOutcome> {
  try {
    return await withClient(target, timeoutMs, async (client) => {
      const walk = await walkToolList(client, timeoutMs, (tools) =>
        tools.find((tool) => tool.name === canary.tool),
      );
      if (walk.found === undefined) {
        return canaryFailure(
          `canary tool "${canary.tool}" was not found in ${walk.pagesRead} page(s) of tools/list${
            walk.truncation === null ? '' : ` (the walk stopped early: ${walk.truncation.reason})`
          }`,
        );
      }
      const accepted = ToolSchema.safeParse(walk.found);
      if (!accepted.success) {
        return canaryFailure(
          `canary tool "${canary.tool}" is advertised with a definition clients on @modelcontextprotocol/sdk 1.x reject, so they can neither list nor call it — ${rejectionEntries(accepted.error.issues).join('; ')}`,
        );
      }
      // A private method across a caret range: name the incompatibility rather than blame the server.
      const cache = client as unknown as Partial<ToolMetadataCache>;
      if (typeof cache.cacheToolMetadata !== 'function') {
        return canaryFailure(
          'the installed @modelcontextprotocol/sdk client has no cacheToolMetadata, which the canary needs to apply the SDK output-schema checks; this SDK release is incompatible with this mcp-crosscheck version',
        );
      }
      cache.cacheToolMetadata([accepted.data]);
      const result = await client.callTool(
        { arguments: canary.args, name: canary.tool },
        undefined,
        { timeout: timeoutMs },
      );
      if (result.isError === true) {
        const content = Array.isArray(result.content) ? result.content[0] : undefined;
        const text =
          content !== undefined && typeof content === 'object' && 'text' in content
            ? String(content.text)
            : 'tool returned isError';
        return canaryFailure(text);
      }
      return { attempted: true, detail: null, ok: true };
    });
  } catch (error) {
    return canaryFailure(String(error));
  }
}
