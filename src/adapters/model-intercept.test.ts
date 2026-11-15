/**
 * @file src/adapters/model-intercept.test.ts
 * The loopback model intercept both capture-only adapters share: what it
 * captures, how it replies, how the capture / exit / timeout race settles, and
 * that the client and the listener are gone before the outcome returns.
 */
import { describe, expect, test } from 'bun:test';
import { managed } from '../../tests/helpers/fake-exec.js';
import type { ManagedProcess } from '../util/exec.js';
import { type InterceptRequest, interceptModelRequest } from './model-intercept.js';

const TOOLS_BODY = { tools: [{ name: 'mcp__target__echo' }] };

interface Seen {
  kills: number;
  port: number;
  replies: { body: string; contentType: string | null; status: number }[];
  requests: InterceptRequest[];
}

/** A client that sends `requests` to the intercept in order, awaiting each reply. */
function client(
  requests: [string, RequestInit][],
  process: Partial<Parameters<typeof managed>[0]> = {},
): { launch: (port: number) => Promise<ManagedProcess>; seen: Seen } {
  const seen: Seen = { kills: 0, port: 0, replies: [], requests: [] };
  return {
    launch: (port) => {
      seen.port = port;
      void (async () => {
        try {
          for (const [path, init] of requests) {
            const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
            seen.replies.push({
              body: await response.text(),
              contentType: response.headers.get('content-type'),
              status: response.status,
            });
          }
        } catch {
          /* teardown cuts the request that settled the race */
        }
      })();
      return Promise.resolve(managed({ ...process, onKill: () => (seen.kills += 1) }));
    },
    seen,
  };
}

const post = (body: unknown): RequestInit => ({ body: JSON.stringify(body), method: 'POST' });

describe('interceptModelRequest', () => {
  test('captures the first JSON body carrying a non-empty tools array; other requests are only answered', async () => {
    const { launch, seen } = client([
      ['/v1/a', { body: 'not json', method: 'POST' }],
      ['/v1/b', post({ tools: [] })],
      ['/v1/c', post({ model: 'no tools' })],
      ['/v1/d', post(TOOLS_BODY)],
      ['/v1/e', post({ tools: [{ name: 'second' }] })],
    ]);
    const outcome = await interceptModelRequest({
      launch,
      reply: (request) => {
        seen.requests.push(request);
        return { body: '{}', status: 200 };
      },
      timeoutMs: 60_000,
    });
    expect(outcome).toEqual({ body: TOOLS_BODY, kind: 'captured' });
    expect(seen.requests.slice(0, 4)).toEqual([
      { method: 'POST', url: '/v1/a' },
      { method: 'POST', url: '/v1/b' },
      { method: 'POST', url: '/v1/c' },
      { method: 'POST', url: '/v1/d' },
    ]);
    expect(seen.replies.slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () => ({
        body: '{}',
        contentType: 'application/json',
        status: 200,
      })),
    );
  });

  test('a reply with no body is sent bare; one with a body is sent as JSON, with its status', async () => {
    const { launch, seen } = client([
      ['/api/hello', { method: 'HEAD' }],
      ['/v1/messages', post({ model: 'no tools' })],
      ['/v1/messages', post(TOOLS_BODY)],
    ]);
    await interceptModelRequest({
      launch,
      reply: ({ method }) =>
        method === 'HEAD' ? { status: 200 } : { body: '{"e":1}', status: 401 },
      timeoutMs: 60_000,
    });
    expect(seen.replies.slice(0, 2)).toEqual([
      { body: '', contentType: null, status: 200 },
      { body: '{"e":1}', contentType: 'application/json', status: 401 },
    ]);
  });

  test('a client that exits first settles the race with its exit and its stderr tail', async () => {
    const { launch, seen } = client([], {
      spawnErrorCode: 'ENOENT',
      stderr: 'Error: spawn npx ENOENT',
    });
    const outcome = await interceptModelRequest({
      launch,
      reply: () => ({ status: 200 }),
      timeoutMs: 60_000,
    });
    expect(outcome).toEqual({
      exit: { code: null, signal: null, spawnErrorCode: 'ENOENT' },
      kind: 'exited',
      stderrTail: 'Error: spawn npx ENOENT',
    });
    expect(seen.kills).toBe(1);
  });

  test('a client that never sends a tools-bearing request runs out the budget', async () => {
    const { launch, seen } = client([['/v1/x', post({ model: 'no tools' })]]);
    const outcome = await interceptModelRequest({
      launch,
      reply: () => ({ status: 200 }),
      timeoutMs: 1,
    });
    expect(outcome).toEqual({ kind: 'timeout' });
    expect(seen.kills).toBe(1);
  });

  for (const [name, process, timeoutMs, requests] of [
    ['a capture', {}, 60_000, [['/v1/x', post(TOOLS_BODY)]]],
    ['an exit', { exited: true }, 60_000, []],
    ['a timeout', {}, 1, []],
  ] as const) {
    test(`after ${name}, the client is killed once and the listener refuses connections`, async () => {
      const { launch, seen } = client([...requests] as [string, RequestInit][], process);
      await interceptModelRequest({ launch, reply: () => ({ status: 200 }), timeoutMs });
      expect(seen.kills).toBe(1);
      await expect(fetch(`http://127.0.0.1:${seen.port}/`)).rejects.toThrow();
    });
  }

  test('a launch that throws closes the listener and propagates', async () => {
    let port = 0;
    const run = interceptModelRequest({
      launch: (assigned) => {
        port = assigned;
        return Promise.reject(new Error('config write failed'));
      },
      reply: () => ({ status: 200 }),
      timeoutMs: 60_000,
    });
    await expect(run).rejects.toThrow('config write failed');
    expect(port).toBeGreaterThan(0);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});
