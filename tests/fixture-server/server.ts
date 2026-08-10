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
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  FIXTURE_SERVER_NAME,
  FIXTURE_SERVER_VERSION,
  FIXTURE_STRUCTURED_RESULTS,
  FIXTURE_TOOLS,
} from './tools.js';

const DEFAULT_HTTP_PORT = 8901;

function createFixtureServer(): Server {
  const server = new Server(
    { name: FIXTURE_SERVER_NAME, version: FIXTURE_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: FIXTURE_TOOLS }));

  /**
   * Every tool echoes the arguments it received, so a canary round-trip proves
   * argument fidelity. A tool that advertises an `outputSchema` answers with its
   * structured payload alongside the echo, which the SDK client requires.
   */
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { arguments: args, name } = request.params;
    if (!FIXTURE_TOOLS.some((tool) => tool.name === name)) {
      return { content: [{ text: `unknown tool: ${name}`, type: 'text' }], isError: true };
    }
    const structuredContent = FIXTURE_STRUCTURED_RESULTS[name];
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
async function handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
  const transport = new StreamableHTTPServerTransport({});
  response.on('close', () => void transport.close());
  await createFixtureServer().connect(transport as Transport);
  await transport.handleRequest(request, response);
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
