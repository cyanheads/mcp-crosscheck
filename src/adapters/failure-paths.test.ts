/**
 * @file src/adapters/failure-paths.test.ts
 * Status classification for every adapter, driven through the injectable `Exec`
 * seam so no test has to break a real upstream. Each test names the branch it
 * pins: `adapter-broken` (the client itself failed to launch),
 * `handshake-failure` (the client ran but could not read the server), or a
 * clean capture. Only child-process spawning is faked — the codex intercept
 * server and mcpo's readiness polling stay real.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AdapterContext } from '../types.js';
import type { Exec, ExecResult, ManagedProcess } from '../util/exec.js';
import { codexAdapter } from './codex.js';
import { inspectorAdapter } from './inspector.js';
import { mcpoAdapter } from './mcpo.js';

let workDir = '';

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'crosscheck-failure-paths-'));
});

afterAll(async () => {
  await rm(workDir, { force: true, recursive: true });
});

function context(exec: Exec, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    artifactsDir: null,
    canary: null,
    exec,
    log: () => {},
    mcpoWith: [],
    // Pinning short-circuits version resolution, so no test reaches a registry.
    pins: { codex: '0.147.0', inspector: '2.1.0', mcpo: '0.0.20' },
    target: { args: ['server.js'], command: 'node', env: {}, kind: 'stdio' },
    timeoutMs: 5_000,
    workDir,
    ...overrides,
  };
}

const EXEC_DEFAULT: ExecResult = { code: 0, signal: null, stderr: '', stdout: '', timedOut: false };
const NEVER_EXITS = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});

/** A managed-process stub. `exited` settles only when the scenario says the child died. */
function managed(opts: { exited?: boolean; onKill?: () => void; stderr?: string }): ManagedProcess {
  return {
    exited: opts.exited === true ? Promise.resolve({ code: 1, signal: null }) : NEVER_EXITS,
    hasExited: () => opts.exited === true,
    kill: () => opts.onKill?.(),
    stderrTail: () => opts.stderr ?? '',
    stdoutTail: () => '',
  };
}

/** An `Exec` whose `capture` replays a script (the last entry repeats) and never spawns. */
function captureExec(...script: Partial<ExecResult>[]): Exec {
  let index = 0;
  return {
    capture: () => {
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      return Promise.resolve({ ...EXEC_DEFAULT, ...step });
    },
    spawn: () => {
      throw new Error('this adapter should not have spawned a managed process');
    },
  };
}

/** An `Exec` that only spawns — used where the adapter's version is pinned. */
function spawnExec(spawn: Exec['spawn']): Exec {
  return {
    capture: () => {
      throw new Error('this adapter should not have captured a command');
    },
    spawn,
  };
}

describe('inspector', () => {
  test('adapter-broken: npx could not install the client', async () => {
    const result = await inspectorAdapter.run(
      context(captureExec({ code: 1, stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found' })),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toContain('E404');
    expect(result.surface).toBeNull();
  });

  test('handshake-failure: the client ran but the server refused it', async () => {
    const result = await inspectorAdapter.run(
      context(captureExec({ code: 1, stderr: 'Error: MCP error -32000: Connection closed' })),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toContain('Connection closed');
  });

  test('handshake-failure: the stage timed out, and the detail names the budget', async () => {
    const result = await inspectorAdapter.run(
      context(captureExec({ timedOut: true }), { timeoutMs: 1_500 }),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toBe('timed out after 1500ms');
  });

  test('handshake-failure: unparseable stdout does not crash the adapter', async () => {
    const result = await inspectorAdapter.run(
      context(captureExec({ stdout: 'Debugger listening on ws://127.0.0.1:9229' })),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.surface).toBeNull();
  });

  test('ok: tools/list parses and the canary round-trips', async () => {
    const exec = captureExec(
      {
        stdout: JSON.stringify({
          tools: [
            {
              description: 'Echo.',
              inputSchema: { properties: { message: { type: 'string' } }, type: 'object' },
              name: 'echo_message',
            },
          ],
        }),
      },
      { stdout: JSON.stringify({ content: [{ text: '{"message":"probe"}', type: 'text' }] }) },
    );
    const result = await inspectorAdapter.run(
      context(exec, { canary: { args: { message: 'probe' }, tool: 'echo_message' } }),
    );
    expect(result.status).toBe('ok');
    expect(result.surface?.tools.map((tool) => tool.name)).toEqual(['echo_message']);
    expect(result.canary).toEqual({ attempted: true, detail: null, ok: true });
  });

  test('ok surface, failed canary: the server rejected the call', async () => {
    const exec = captureExec(
      { stdout: JSON.stringify({ tools: [] }) },
      {
        stdout: JSON.stringify({
          content: [{ text: 'message is required', type: 'text' }],
          isError: true,
        }),
      },
    );
    const result = await inspectorAdapter.run(
      context(exec, { canary: { args: {}, tool: 'echo_message' } }),
    );
    expect(result.status).toBe('ok');
    expect(result.canary?.ok).toBe(false);
    expect(result.canary?.detail).toContain('message is required');
  });
});

const OPENAPI_DOC = JSON.stringify({
  paths: {
    '/echo_message': {
      post: {
        description: 'Echo a message back.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: { message: { description: 'The message.', type: 'string' } },
                required: ['message'],
                type: 'object',
              },
            },
          },
        },
      },
    },
  },
});

/** Fake `uvx mcpo` that serves a document on the port it was told to listen on. */
function openApiSpawn(document: string): Exec['spawn'] {
  return (_command, args) => {
    const port = Number(args[args.indexOf('--port') + 1]);
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(request.url === '/openapi.json' ? document : '{"result":"ok"}');
    });
    server.listen(port, '127.0.0.1');
    return managed({ onKill: () => server.close() });
  };
}

describe('mcpo', () => {
  test('adapter-broken: the proxy died before serving openapi.json', async () => {
    const traceback =
      'Traceback (most recent call last):\n  File "mcpo/main.py", line 9\nImportError: cannot import name streamablehttp_client';
    const result = await mcpoAdapter.run(
      context(spawnExec(() => managed({ exited: true, stderr: traceback }))),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toContain('ImportError');
    expect(result.statusDetail).not.toContain('\n');
    expect(result.resolvedVersion).toBe('0.0.20');
  });

  test('handshake-failure: the proxy stayed up but never became ready', async () => {
    const result = await mcpoAdapter.run(
      context(
        spawnExec(() => managed({})),
        { timeoutMs: 300 },
      ),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toContain('timed out');
    expect(result.surface).toBeNull();
  });

  test('handshake-failure: openapi.json is served but is not a document', async () => {
    const result = await mcpoAdapter.run(context(spawnExec(openApiSpawn('"not a document"'))));
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toBe('openapi.json was not parseable');
  });

  test('ok: the generated openapi.json becomes the rendered surface', async () => {
    const result = await mcpoAdapter.run(
      context(spawnExec(openApiSpawn(OPENAPI_DOC)), {
        canary: { args: { message: 'probe' }, tool: 'echo_message' },
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.surface?.tools.map((tool) => tool.name)).toEqual(['echo_message']);
    expect(result.canary).toEqual({ attempted: true, detail: null, ok: true });
  });
});

interface CodexFake {
  /** The config.toml the adapter wrote into the throwaway CODEX_HOME. */
  config: () => string;
  spawn: Exec['spawn'];
}

/** Fake `codex exec`: reads the intercept port out of config.toml and posts one request body. */
function codexSpawn(body: unknown): CodexFake {
  let config = '';
  return {
    config: () => config,
    spawn: (_command, _args, opts) => {
      config = readFileSync(join(opts.env?.CODEX_HOME ?? '', 'config.toml'), 'utf8');
      const port = /127\.0\.0\.1:(\d+)/.exec(config)?.[1];
      void fetch(`http://127.0.0.1:${port}/v1/responses`, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      return managed({});
    },
  };
}

describe('codex', () => {
  test('rejects streamable-http targets', () => {
    expect(codexAdapter.supports({ kind: 'http', url: 'https://example.com/mcp' })).toContain(
      'stdio',
    );
  });

  test('adapter-broken: codex exited before issuing a model request', async () => {
    const result = await codexAdapter.run(
      context(spawnExec(() => managed({ exited: true, stderr: 'npm error 404 Not Found' }))),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toContain('404 Not Found');
  });

  test('handshake-failure: the captured request carried no MCP tools', async () => {
    const fake = codexSpawn({ tools: [{ name: 'shell', type: 'function' }] });
    const result = await codexAdapter.run(context(spawnExec(fake.spawn)));
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toContain('no MCP tools');
  });

  test('handshake-failure: nothing was captured within the budget', async () => {
    const result = await codexAdapter.run(
      context(
        spawnExec(() => managed({})),
        { timeoutMs: 300 },
      ),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toBe('no model request captured within 300ms');
  });

  test('ok: the intercepted namespace becomes the rendered surface', async () => {
    const fake = codexSpawn({
      tools: [
        { name: 'shell', type: 'function' },
        {
          name: 'mcp__target',
          tools: [
            {
              description: 'Echo.',
              name: 'echo_message',
              parameters: { properties: { message: { type: 'string' } }, type: 'object' },
            },
          ],
          type: 'namespace',
        },
      ],
    });
    const result = await codexAdapter.run(context(spawnExec(fake.spawn)));
    expect(result.status).toBe('ok');
    expect(result.surface?.tools.map((tool) => tool.name)).toEqual(['echo_message']);
    expect(result.canary).toEqual({
      attempted: false,
      detail: 'codex adapter is capture-only',
      ok: null,
    });
    expect(fake.config()).toContain('[mcp_servers.target]');
    expect(fake.config()).toContain('command = "node"');
  });
});
