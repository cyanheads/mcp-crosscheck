/**
 * @file src/adapters/model-intercept.ts
 * The loopback stand-in for a model provider that the capture-only adapters
 * (codex, claude-code) run their client against. It listens on 127.0.0.1,
 * reads every request body, and captures the first JSON body carrying a
 * non-empty `tools` array: the client's converted view of the MCP server,
 * sent before any model reply matters. One race settles the run — that
 * capture, the client exiting first, or the budget running out — and the
 * client and the listener are torn down before the outcome is returned,
 * however it ended.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { isRecord } from '../schema.js';
import type { ChildExit, ManagedProcess } from '../util/exec.js';

/** The part of a request a client's reply depends on. */
export interface InterceptRequest {
  method: string;
  url: string;
}

/** What the intercept answers a request with. A `body` is sent as `application/json`. */
export interface InterceptReply {
  body?: string;
  status: number;
}

/** How the race ended. `exited` carries the client's stderr tail as it was when the race settled. */
export type InterceptOutcome =
  | { body: unknown; kind: 'captured' }
  | { exit: ChildExit; kind: 'exited'; stderrTail: string }
  | { kind: 'timeout' };

export interface InterceptOptions {
  /**
   * Start the client against the intercept on `port`. It runs inside the
   * boundary that closes the listener, so a throw here still closes it and
   * then propagates.
   */
  launch: (port: number) => ManagedProcess | Promise<ManagedProcess>;
  /** The answer to each request, sent once its body has been read. */
  reply: (request: InterceptRequest) => InterceptReply;
  /** How long the client has to send a tools-bearing request, from launch. */
  timeoutMs: number;
}

/** True for a parsed request body that carries the client's rendered tool list. */
function carriesTools(body: unknown): boolean {
  return isRecord(body) && Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * Run one client against the intercept and report how its first
 * tools-bearing request, its exit, or the budget settled the race. The client
 * is killed exactly once and the listener closed, with its open connections,
 * before this returns or throws.
 */
export async function interceptModelRequest(options: InterceptOptions): Promise<InterceptOutcome> {
  let resolveCaptured: (body: unknown) => void = () => {};
  const captured = new Promise<unknown>((resolve) => {
    resolveCaptured = resolve;
  });
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (carriesTools(body)) resolveCaptured(body);
      } catch {
        /* a body that is not JSON cannot carry a rendered tool surface */
      }
      const reply = options.reply({ method: request.method ?? '', url: request.url ?? '' });
      if (reply.body === undefined) {
        response.writeHead(reply.status).end();
        return;
      }
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  let proc: ManagedProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    proc = await options.launch((server.address() as AddressInfo).port);
    const client = proc;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), options.timeoutMs);
    });
    return await Promise.race([
      captured.then((body) => ({ body, kind: 'captured' }) as const),
      client.exited.then(
        (exit) => ({ exit, kind: 'exited', stderrTail: client.stderrTail() }) as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    proc?.kill();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
