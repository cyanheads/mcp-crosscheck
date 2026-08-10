/**
 * @file src/util/net.ts
 * Networking helpers: ephemeral port allocation, bounded JSON fetches, and
 * readiness polling that fails fast when the watched child process dies.
 */
import net from 'node:net';

/** Ask the OS for a free TCP port on the loopback interface. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate an ephemeral port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export interface FetchJsonResult {
  body: unknown;
  ok: boolean;
  status: number;
  text: string;
}

/** GET/POST a URL with a hard timeout; body is parsed JSON or null when unparseable. */
export async function fetchJson(
  url: string,
  opts: { body?: unknown; method?: 'GET' | 'POST'; timeoutMs: number },
): Promise<FetchJsonResult> {
  const method = opts.method ?? 'GET';
  const response = await fetch(url, {
    ...(opts.body !== undefined
      ? { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } }
      : {}),
    method,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body — callers read `text` */
  }
  return { body, ok: response.ok, status: response.status, text };
}

/**
 * Poll `probe` until it returns true. Resolves null on ready, or a failure
 * reason when `failFast` reports one (e.g. the child exited) or time runs out.
 */
export async function waitForReady(opts: {
  failFast?: () => string | null;
  intervalMs: number;
  probe: () => Promise<boolean>;
  timeoutMs: number;
}): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const failure = opts.failFast?.() ?? null;
    if (failure !== null) return failure;
    try {
      if (await opts.probe()) return null;
    } catch {
      /* not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
  return `timed out after ${opts.timeoutMs}ms waiting for readiness`;
}
