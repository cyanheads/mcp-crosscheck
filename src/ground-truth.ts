/**
 * @file src/ground-truth.ts
 * Captures the server's own advertised surface via the official MCP TypeScript
 * SDK client — the baseline every adapter's rendered surface is diffed against.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
  CanaryOutcome,
  CanarySpec,
  GroundTruth,
  GroundTruthTool,
  JsonSchema,
  TargetSpec,
} from './types.js';
import { excerpt } from './util/exec.js';
import { VERSION } from './version.js';

const MAX_TOOL_PAGES = 100;

function buildTransport(target: TargetSpec): Transport {
  if (target.kind === 'http') {
    // Widening cast: the SDK is not compiled with exactOptionalPropertyTypes,
    // so its concrete transport's `sessionId: string | undefined` does not
    // satisfy the Transport interface under this project's stricter settings.
    return new StreamableHTTPClientTransport(new URL(target.url)) as Transport;
  }
  return new StdioClientTransport({
    args: target.args,
    command: target.command,
    env: { ...getDefaultEnvironment(), ...target.env },
    stderr: 'ignore',
  });
}

async function withClient<T>(
  target: TargetSpec,
  timeoutMs: number,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: 'mcp-crosscheck', version: VERSION });
  const transport = buildTransport(target);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ground-truth client timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    return await Promise.race([fn(client), timeout]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {
      /* transport already gone */
    });
  }
}

/** Connect with the official SDK client and capture serverInfo plus the full paginated tool list. */
export function captureGroundTruth(target: TargetSpec, timeoutMs: number): Promise<GroundTruth> {
  return withClient(target, timeoutMs, async (client) => {
    const serverInfo = client.getServerVersion();
    const tools: GroundTruthTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await client.listTools(cursor === undefined ? {} : { cursor }, {
        timeout: timeoutMs,
      });
      for (const tool of result.tools) {
        tools.push({
          description: typeof tool.description === 'string' ? tool.description : null,
          inputSchema: tool.inputSchema as JsonSchema,
          name: tool.name,
          // Most tools advertise no result schema; the key stays off those.
          ...(tool.outputSchema === undefined
            ? {}
            : { outputSchema: tool.outputSchema as JsonSchema }),
        });
      }
      if (result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }
    return {
      serverName: serverInfo?.name ?? null,
      serverVersion: serverInfo?.version ?? null,
      tools,
    };
  });
}

/**
 * Call the canary tool directly through the SDK client. This must succeed
 * before any adapter runs — a canary that fails against ground truth is a bad
 * canary spec, not a client bug.
 */
export async function runGroundTruthCanary(
  target: TargetSpec,
  canary: CanarySpec,
  timeoutMs: number,
): Promise<CanaryOutcome> {
  try {
    return await withClient(target, timeoutMs, async (client) => {
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
        return { attempted: true, detail: excerpt(text), ok: false };
      }
      return { attempted: true, detail: null, ok: true };
    });
  } catch (error) {
    return { attempted: true, detail: excerpt(String(error)), ok: false };
  }
}
