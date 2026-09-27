/**
 * @file tests/fixture-server/server.ts
 * Bundled MCP fixture server: the hermetic target the test suite runs against,
 * so no test depends on an external server repo. Built on the low-level `Server`
 * class with hand-written request handlers — the high-level `McpServer` would
 * own schema generation, and the whole point of this fixture is that the
 * advertised schemas are verbatim literals.
 *
 * Run it directly:
 *   bun tests/fixture-server/server.ts
 *   MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=8901 bun tests/fixture-server/server.ts
 *
 * `MCP_FIXTURE_TOOLS`, a JSON tool array, replaces the advertised tools for a
 * test that needs a surface the fixture does not carry.
 *
 * Switches that misbehave on purpose, all off by default:
 *   MCP_FIXTURE_PAGE_SIZE=<n>        page `tools/list` n tools at a time
 *   MCP_FIXTURE_CURSOR=repeat        answer every page with the same `nextCursor`
 *   MCP_FIXTURE_CURSOR=cycle         alternate `nextCursor` between two values
 *   MCP_FIXTURE_INVALID_OUTPUT=mismatch|missing
 *                                    `nested_config` answers with `structuredContent`
 *                                    that violates its `outputSchema`, or with none
 */
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  FIXTURE_SERVER_NAME,
  FIXTURE_SERVER_VERSION,
  FIXTURE_STRUCTURED_RESULTS,
  FIXTURE_TOOLS,
} from './tools.js';

const DEFAULT_HTTP_PORT = 8901;

const ADVERTISED_TOOLS: Tool[] =
  process.env.MCP_FIXTURE_TOOLS === undefined
    ? FIXTURE_TOOLS
    : JSON.parse(process.env.MCP_FIXTURE_TOOLS);

const PAGE_SIZE = Math.max(
  1,
  Number(process.env.MCP_FIXTURE_PAGE_SIZE ?? (ADVERTISED_TOOLS.length || 1)),
);
const CURSOR_MODE = process.env.MCP_FIXTURE_CURSOR;
const INVALID_OUTPUT = process.env.MCP_FIXTURE_INVALID_OUTPUT;

/**
 * The page a cursor names. Well-behaved cursors are `page-<index>`; `repeat`
 * serves page 1, and the `cycle` pair `a`/`b` serve pages 1 and 2.
 */
function pageIndex(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (cursor === 'repeat' || cursor === 'a') return 1;
  if (cursor === 'b') return 2;
  const match = /^page-(\d+)$/.exec(cursor);
  if (match === null) throw new McpError(ErrorCode.InvalidParams, `unknown cursor: ${cursor}`);
  return Number(match[1]);
}

/** The `nextCursor` after one page, or undefined on the last page of a well-behaved list. */
function nextCursorAfter(index: number): string | undefined {
  if (CURSOR_MODE === 'repeat') return 'repeat';
  if (CURSOR_MODE === 'cycle') return index % 2 === 0 ? 'a' : 'b';
  return (index + 1) * PAGE_SIZE < ADVERTISED_TOOLS.length ? `page-${index + 1}` : undefined;
}

/** `nested_config`'s structured result, or the invalid one a switch asks for. */
function structuredResultFor(name: string): Record<string, unknown> | undefined {
  const result = FIXTURE_STRUCTURED_RESULTS[name];
  if (name !== 'nested_config' || INVALID_OUTPUT === undefined) return result;
  if (INVALID_OUTPUT === 'missing') return undefined;
  return { ...result, summary: { connected: 'yes' } };
}

function createFixtureServer(): Server {
  const server = new Server(
    { name: FIXTURE_SERVER_NAME, version: FIXTURE_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const index = pageIndex(request.params?.cursor);
    const nextCursor = nextCursorAfter(index);
    return {
      tools: ADVERTISED_TOOLS.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  });

  /**
   * Every tool echoes the arguments it received, so a canary round-trip proves
   * argument fidelity. A tool that advertises an `outputSchema` answers with its
   * structured payload alongside the echo, which the SDK client requires.
   */
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { arguments: args, name } = request.params;
    if (!ADVERTISED_TOOLS.some((tool) => tool.name === name)) {
      return { content: [{ text: `unknown tool: ${name}`, type: 'text' }], isError: true };
    }
    const structuredContent = structuredResultFor(name);
    return {
      content: [{ text: JSON.stringify(args ?? {}), type: 'text' }],
      ...(structuredContent === undefined ? {} : { structuredContent }),
    };
  });

  return server;
}

/**
 * One server + transport pair per request: the SDK's stateless streamable-http
 * mode refuses to reuse a transport across requests. The widening cast is the
 * same `exactOptionalPropertyTypes` gap worked around in src/ground-truth.ts.
 */
function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text === '' ? undefined : JSON.parse(text));
      } catch {
        reject(new Error('request body was not valid JSON'));
      }
    });
  });
}

const transports = new Map<string, StreamableHTTPServerTransport>();

async function recordRequest(request: IncomingMessage, body: unknown): Promise<void> {
  const path = process.env.MCP_HTTP_RECORD_PATH;
  if (path === undefined) return;
  const headerName = process.env.MCP_REQUIRED_HEADER_NAME?.toLowerCase();
  const header = headerName === undefined ? null : (request.headers[headerName] ?? null);
  const rpc = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const rpcMethod = 'method' in rpc ? String(rpc.method) : null;
  const params = rpc.params;
  // Only a paged request carries the key, so earlier record shapes are unchanged.
  const cursor =
    typeof params === 'object' && params !== null && 'cursor' in params
      ? { cursor: params.cursor }
      : {};
  await appendFile(
    path,
    `${JSON.stringify({ header, method: request.method, rpcMethod, ...cursor })}\n`,
  );
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
  const body = request.method === 'POST' ? await readBody(request) : undefined;
  await recordRequest(request, body);

  const headerName = process.env.MCP_REQUIRED_HEADER_NAME;
  const expected = process.env.MCP_REQUIRED_HEADER_VALUE;
  const supplied = headerName === undefined ? undefined : request.headers[headerName.toLowerCase()];
  if (headerName !== undefined && (expected === undefined || supplied !== expected)) {
    response.writeHead(401, { 'content-type': 'text/plain' });
    response.end(`required header rejected: ${expected ?? ''}`);
    return;
  }
  if (process.env.MCP_REJECT_HEADER === '1' && expected !== undefined) {
    response.statusMessage = `controlled rejection ${expected}`;
    response.writeHead(401, { 'content-type': 'text/plain' });
    response.end(`controlled rejection: ${expected}`);
    return;
  }

  const sessionId = request.headers['mcp-session-id'];
  let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
  if (transport === undefined && request.method === 'POST' && sessionId === undefined) {
    transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      onsessioninitialized: (initializedId) => {
        transports.set(initializedId, transport!);
      },
      sessionIdGenerator: randomUUID,
    });
    await createFixtureServer().connect(transport as Transport);
  }
  if (transport === undefined) {
    response.writeHead(400).end('unknown MCP session');
    return;
  }
  await transport.handleRequest(request, response, body);
  if (request.method === 'DELETE' && typeof sessionId === 'string') transports.delete(sessionId);
}

if (process.env.MCP_TRANSPORT_TYPE === 'http') {
  const port = Number(process.env.MCP_HTTP_PORT ?? DEFAULT_HTTP_PORT);
  createServer((request, response) => {
    handleHttpRequest(request, response).catch((error: unknown) => {
      process.stderr.write(`fixture-server: request failed — ${String(error)}\n`);
      response.writeHead(500).end();
    });
  }).listen(port, '127.0.0.1', () => {
    process.stderr.write(`fixture-server: streamable-http on http://127.0.0.1:${port}\n`);
  });
} else {
  await createFixtureServer().connect(new StdioServerTransport());
}
