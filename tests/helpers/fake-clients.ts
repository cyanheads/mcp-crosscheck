/**
 * @file tests/helpers/fake-clients.ts
 * Fake Codex and Claude Code clients for the capture-only adapters: once
 * spawned, each talks to the adapter's real loopback intercept, so only the
 * child process is faked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec, SpawnOptions } from '../../src/util/exec.js';
import { managed } from './fake-exec.js';

/** A reply the adapter's loopback intercept gave a fake client. */
export interface InterceptReply {
  body: string;
  contentType: string | null;
  status: number;
}

/** What a fake capture-only client was handed and did, read after the adapter run. */
export interface FakeClient {
  args: () => string[];
  command: () => string;
  /** The client configuration the adapter wrote: Codex's config.toml or Claude Code's MCP JSON. */
  config: () => string;
  killed: () => number;
  options: () => SpawnOptions;
  port: () => number;
  /** Replies to the requests that completed before teardown, in request order. */
  replies: () => InterceptReply[];
  spawn: Exec['spawn'];
}

/**
 * A fake client that, once spawned, sends each request in order to the
 * intercept `locate` finds in its spawn arguments, awaiting each reply. Teardown
 * can cut the request that triggered it; that rejection is swallowed.
 */
function interceptClient(
  locate: (args: string[], opts: SpawnOptions) => { config: string; origin: string },
  requests: (origin: string) => [string, RequestInit][],
  onSpawn?: () => void,
): FakeClient {
  let args: string[] = [];
  let command = '';
  let config = '';
  let killed = 0;
  let options: SpawnOptions = {};
  let port = 0;
  const replies: InterceptReply[] = [];
  return {
    args: () => args,
    command: () => command,
    config: () => config,
    killed: () => killed,
    options: () => options,
    port: () => port,
    replies: () => replies,
    spawn: (spawnedCommand, spawnedArgs, opts) => {
      command = spawnedCommand;
      args = spawnedArgs;
      options = opts;
      const located = locate(spawnedArgs, opts);
      config = located.config;
      port = Number(new URL(located.origin).port);
      onSpawn?.();
      void (async () => {
        try {
          for (const [url, init] of requests(located.origin)) {
            const response = await fetch(url, init);
            replies.push({
              body: await response.text(),
              contentType: response.headers.get('content-type'),
              status: response.status,
            });
          }
        } catch {
          /* adapter teardown can close the listener while the fake is still returning */
        }
      })();
      return managed({ onKill: () => (killed += 1) });
    },
  };
}

/** A JSON POST of `body`, as both clients send their model requests. */
function jsonPost(body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  };
}

/** Fake `codex exec`: reads the intercept out of the config.toml in CODEX_HOME and posts each body. */
export function fakeCodexClient(bodies: unknown[], onSpawn?: () => void): FakeClient {
  return interceptClient(
    (_args, opts) => {
      const config = readFileSync(join(opts.env?.CODEX_HOME ?? '', 'config.toml'), 'utf8');
      const port = /base_url = "http:\/\/127\.0\.0\.1:(\d+)\/v1"/.exec(config)?.[1];
      return { config, origin: `http://127.0.0.1:${port}` };
    },
    (origin) => bodies.map((body) => [`${origin}/v1/responses`, jsonPost(body)]),
    onSpawn,
  );
}

/** Fake installed `claude`: performs its observed HEAD probe, then posts each body. */
export function fakeClaudeCodeClient(bodies: unknown[], onSpawn?: () => void): FakeClient {
  return interceptClient(
    (args, opts) => ({
      config: readFileSync(args[args.indexOf('--mcp-config') + 1] ?? '', 'utf8'),
      origin: opts.env?.ANTHROPIC_BASE_URL ?? '',
    }),
    (origin) => [
      [`${origin}/api/hello`, { method: 'HEAD' }],
      ...bodies.map((body): [string, RequestInit] => [
        `${origin}/v1/messages?beta=true`,
        jsonPost(body),
      ]),
    ],
    onSpawn,
  );
}
