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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRedactor } from '../redact.js';
import type { AdapterContext } from '../types.js';
import type { Exec, ExecResult, ManagedProcess, SpawnOptions } from '../util/exec.js';
import { claudeCodeAdapter } from './claude-code.js';
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
    pins: {
      'claude-code': '2.1.231',
      codex: '0.147.0-alpha.6.5',
      inspector: '2.1.0',
      mcpo: '0.0.20',
    },
    redact: (text) => text,
    target: { args: ['server.js'], command: 'node', env: {}, kind: 'stdio' },
    timeoutMs: 5_000,
    workDir,
    ...overrides,
  };
}

const EXEC_DEFAULT: ExecResult = { code: 0, signal: null, stderr: '', stdout: '', timedOut: false };
const NEVER_EXITS = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});
const INSTALL_PREAMBLE = Array.from(
  { length: 30 },
  (_, index) => `resolving package dependency ${index}`,
).join('\n');
const NPM_INSTALL_FAILURE = `${INSTALL_PREAMBLE}\nnpm ERR! code E404\nnpm ERR! package not found`;
const RICH_IMPORT_FAILURE = [
  INSTALL_PREAMBLE,
  '╭──────────────────── Traceback (most recent call last) ────────────────────╮',
  '│ /tmp/mcpo/bin/mcpo:5 in <module>                                         │',
  '│                                                                          │',
  '│   from mcpo.main import app                                              │',
  '╰──────────────────────────────────────────────────────────────────────────╯',
  'ImportError: cannot import name streamablehttp_client',
].join('\n');

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

/** `captureExec`, with every command's argv appended to `calls` for flag assertions. */
function recordingExec(calls: string[][], ...script: Partial<ExecResult>[]): Exec {
  const inner = captureExec(...script);
  return {
    capture: (command, args, opts) => {
      calls.push(args);
      return inner.capture(command, args, opts);
    },
    spawn: inner.spawn,
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
      context(captureExec({ code: 1, stderr: NPM_INSTALL_FAILURE })),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toStartWith('…');
    expect(result.statusDetail).toContain('npm ERR! code E404');
    expect(result.statusDetail).not.toContain('resolving package dependency 0');
    expect(result.surface).toBeNull();
  });

  test('handshake-failure: the client ran but the server refused it', async () => {
    const result = await inspectorAdapter.run(
      context(captureExec({ code: 1, stderr: 'Error: MCP error -32000: Connection closed' })),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toContain('Connection closed');
  });

  test('redacts a configured value from a controlled rejected response', async () => {
    const secret = 'fixture-secret';
    const result = await inspectorAdapter.run(
      context(captureExec({ code: 1, stderr: `HTTP 401 — controlled rejection: ${secret}` }), {
        redact: createRedactor([secret]),
        target: {
          headers: { 'X-Fixture-Auth': secret },
          kind: 'http',
          url: 'http://127.0.0.1:9000/mcp',
        },
      }),
    );
    expect(result.statusDetail).not.toContain(secret);
    expect(result.statusDetail).toContain('[REDACTED]');
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
    expect(result.surface?.tools[0]?.outputProperties).toBeUndefined();
    expect(result.canary).toEqual({ attempted: true, detail: null, ok: true });
  });

  test('an advertised outputSchema becomes the rendered result model', async () => {
    const exec = captureExec({
      stdout: JSON.stringify({
        tools: [
          {
            description: 'Echo.',
            inputSchema: { properties: { message: { type: 'string' } }, type: 'object' },
            name: 'echo_message',
            outputSchema: {
              properties: { echoed: { description: 'What came back.', type: 'string' } },
              type: 'object',
            },
          },
        ],
      }),
    });
    const result = await inspectorAdapter.run(context(exec));
    const rendered = result.surface?.tools[0];
    expect(rendered?.outputProperties?.map((property) => property.name)).toEqual(['echoed']);
    expect(rendered?.outputProperties?.[0]?.type).toBe('string');
  });

  const LIST_AND_CALL: Partial<ExecResult>[] = [
    { stdout: JSON.stringify({ tools: [] }) },
    { stdout: JSON.stringify({ content: [{ text: '{}', type: 'text' }] }) },
  ];
  const MIXED_ARGS = { count: 3, message: '123', nested: { deep: true } };

  test('the canary goes out as one --tool-args-json object', async () => {
    const calls: string[][] = [];
    const result = await inspectorAdapter.run(
      context(recordingExec(calls, ...LIST_AND_CALL), {
        canary: { args: MIXED_ARGS, tool: 'echo_message' },
      }),
    );
    expect(result.canary?.ok).toBe(true);
    const call = calls[1] ?? [];
    expect(call).not.toContain('--tool-arg');
    expect(call[call.indexOf('--tool-args-json') + 1]).toBe(JSON.stringify(MIXED_ARGS));
  });

  test('a pinned pre-2.0.0 inspector falls back to --tool-arg for string arguments', async () => {
    const calls: string[][] = [];
    const result = await inspectorAdapter.run(
      context(recordingExec(calls, ...LIST_AND_CALL), {
        canary: { args: { mode: 'standard', message: 'probe' }, tool: 'echo_message' },
        pins: { inspector: '1.0.1' },
      }),
    );
    expect(result.canary?.ok).toBe(true);
    const call = calls[1] ?? [];
    expect(call).not.toContain('--tool-args-json');
    expect(call.slice(call.indexOf('--tool-arg'))).toEqual([
      '--tool-arg',
      'mode=standard',
      '--tool-arg',
      'message=probe',
    ]);
  });

  test('a pinned pre-2.0.0 inspector skips rather than mangling what it cannot spell', async () => {
    for (const args of [{ repeat: 3 }, { message: '' }]) {
      const calls: string[][] = [];
      const result = await inspectorAdapter.run(
        context(recordingExec(calls, ...LIST_AND_CALL), {
          canary: { args, tool: 'echo_message' },
          pins: { inspector: '1.0.1' },
        }),
      );
      expect(result.status).toBe('ok');
      expect(result.canary?.attempted).toBe(false);
      expect(result.canary?.ok).toBeNull();
      expect(result.canary?.detail).toContain('--tool-args-json');
      // Skipped means skipped: no tools/call was ever issued.
      expect(calls).toHaveLength(1);
    }
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

  test('streamable-http forwards each configured header as a repeated flag', async () => {
    const calls: string[][] = [];
    await inspectorAdapter.run(
      context(recordingExec(calls, { stdout: JSON.stringify({ tools: [] }) }), {
        target: {
          headers: { Authorization: 'Bearer dummy', 'X-Tenant': 'fixture' },
          kind: 'http',
          url: 'http://127.0.0.1:9000/mcp',
        },
      }),
    );
    expect(calls[0]).toEqual([
      '-y',
      '@modelcontextprotocol/inspector@2.1.0',
      '--cli',
      'http://127.0.0.1:9000/mcp',
      '--transport',
      'http',
      '--header',
      'Authorization: Bearer dummy',
      '--header',
      'X-Tenant: fixture',
      '--method',
      'tools/list',
    ]);
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
function openApiSpawn(document: string, calls?: string[][]): Exec['spawn'] {
  return (_command, args) => {
    calls?.push(args);
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
    const result = await mcpoAdapter.run(
      context(spawnExec(() => managed({ exited: true, stderr: RICH_IMPORT_FAILURE }))),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toContain('from mcpo.main import app');
    expect(result.statusDetail).toContain('ImportError');
    expect(result.statusDetail).not.toContain('resolving package dependency 0');
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

  test('streamable-http passes one JSON header map before the target separator', async () => {
    const calls: string[][] = [];
    await mcpoAdapter.run(
      context(spawnExec(openApiSpawn(OPENAPI_DOC, calls)), {
        target: {
          headers: { Authorization: 'Bearer dummy', 'X-Tenant': 'fixture' },
          kind: 'http',
          url: 'http://127.0.0.1:9000/mcp',
        },
      }),
    );
    const args = calls[0] ?? [];
    const separator = args.indexOf('--');
    expect(args.slice(separator - 2)).toEqual([
      '--header',
      JSON.stringify({ Authorization: 'Bearer dummy', 'X-Tenant': 'fixture' }),
      '--',
      'http://127.0.0.1:9000/mcp',
    ]);
  });
});

interface CodexFake {
  args: () => string[];
  /** The config.toml the adapter wrote into the throwaway CODEX_HOME. */
  config: () => string;
  options: () => SpawnOptions;
  spawn: Exec['spawn'];
}

/** Fake `codex exec`: reads the intercept port out of config.toml and posts one request body. */
function codexSpawn(body: unknown): CodexFake {
  let args: string[] = [];
  let config = '';
  let options: SpawnOptions = {};
  return {
    args: () => args,
    config: () => config,
    options: () => options,
    spawn: (_command, spawnedArgs, opts) => {
      args = spawnedArgs;
      options = opts;
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
  test('supports streamable-http targets', () => {
    expect(
      codexAdapter.supports({ headers: {}, kind: 'http', url: 'https://example.com/mcp' }),
    ).toBe(true);
  });

  test('adapter-broken: codex exited before issuing a model request', async () => {
    const result = await codexAdapter.run(
      context(spawnExec(() => managed({ exited: true, stderr: NPM_INSTALL_FAILURE }))),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toContain('npm ERR! code E404');
    expect(result.statusDetail).not.toContain('resolving package dependency 0');
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
    const timeoutMs = 33_333;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pending = new Set<ReturnType<typeof setTimeout>>();
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const handle = realSetTimeout(...args);
      if (args[1] === timeoutMs) pending.add(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
      pending.delete(handle as ReturnType<typeof setTimeout>);
      realClearTimeout(handle);
    }) as typeof clearTimeout;
    let pendingAfterCapture = -1;
    const result = await codexAdapter
      .run(context(spawnExec(fake.spawn), { timeoutMs }))
      .finally(() => {
        pendingAfterCapture = pending.size;
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
        for (const handle of pending) realClearTimeout(handle);
      });
    expect(result.status).toBe('ok');
    expect(result.surface?.tools.map((tool) => tool.name)).toEqual(['echo_message']);
    expect(result.canary).toEqual({
      attempted: false,
      detail: 'codex adapter is capture-only',
      ok: null,
    });
    expect(fake.config()).toContain('[mcp_servers.target]');
    expect(fake.config()).toContain('command = "node"');
    expect(pendingAfterCapture).toBe(0);
    const port = /127\.0\.0\.1:(\d+)/.exec(fake.config())?.[1];
    expect(fake.config()).toBe(`model = "crosscheck-stub"
model_provider = "crosscheck"

[model_providers.crosscheck]
name = "mcp-crosscheck local intercept"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"

[mcp_servers.target]
command = "node"
args = ["server.js"]
`);
  });

  test('streamable-http config uses url and environment-backed headers without secrets', async () => {
    const artifactsDir = await mkdtemp(join(workDir, 'codex-http-artifacts-'));
    const fake = codexSpawn({
      tools: [
        {
          name: 'mcp__target',
          tools: [{ name: 'echo', parameters: { type: 'object' } }],
          type: 'namespace',
        },
      ],
    });
    const secret = 'dummy-secret-value';
    try {
      const result = await codexAdapter.run(
        context(spawnExec(fake.spawn), {
          artifactsDir,
          target: {
            headers: { Authorization: `Bearer ${secret}`, 'X-Tenant': 'fixture' },
            kind: 'http',
            url: 'http://127.0.0.1:9000/mcp',
          },
        }),
      );
      expect(result.status).toBe('ok');
      expect(fake.config()).toContain('url = "http://127.0.0.1:9000/mcp"');
      expect(fake.config()).toContain(
        'env_http_headers = { "Authorization" = "MCP_CROSSCHECK_TARGET_HEADER_0", "X-Tenant" = "MCP_CROSSCHECK_TARGET_HEADER_1" }',
      );
      expect(fake.config()).not.toContain(secret);
      expect(fake.config()).not.toContain('\nhttp_headers =');
      expect(fake.args().join(' ')).not.toContain(secret);
      expect(fake.options().inheritEnv).toBe(false);
      expect(fake.options().env).toEqual({
        CODEX_HOME: expect.any(String),
        HOME: expect.any(String),
        MCP_CROSSCHECK_TARGET_HEADER_0: `Bearer ${secret}`,
        MCP_CROSSCHECK_TARGET_HEADER_1: 'fixture',
        NO_PROXY: '*',
        PATH: process.env.PATH as string,
      });
      for (const key of [
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'AWS_PROFILE',
      ]) {
        expect(fake.options().env?.[key]).toBeUndefined();
      }
      expect(await readFile(join(artifactsDir, 'codex.request.json'), 'utf8')).not.toContain(
        secret,
      );
    } finally {
      await rm(artifactsDir, { force: true, recursive: true });
    }
  });

  test('streamable-http without headers writes only the target URL', async () => {
    const fake = codexSpawn({
      tools: [
        {
          name: 'mcp__target',
          tools: [{ name: 'echo', parameters: { type: 'object' } }],
          type: 'namespace',
        },
      ],
    });
    const result = await codexAdapter.run(
      context(spawnExec(fake.spawn), {
        target: { headers: {}, kind: 'http', url: 'http://127.0.0.1:9000/mcp' },
      }),
    );
    expect(result.status).toBe('ok');
    expect(fake.config()).toContain('[mcp_servers.target]\nurl = "http://127.0.0.1:9000/mcp"\n');
    expect(fake.config()).not.toContain('env_http_headers');
  });
});

interface ClaudeCodeFake {
  args: () => string[];
  command: () => string;
  config: () => string;
  killed: () => number;
  options: () => SpawnOptions;
  port: () => number;
  spawn: Exec['spawn'];
}

/** Fake installed `claude`: performs its observed HEAD probe, then posts the scripted bodies. */
function claudeCodeSpawn(bodies: unknown[], onSpawn?: () => void): ClaudeCodeFake {
  let args: string[] = [];
  let command = '';
  let config = '';
  let killed = 0;
  let options: SpawnOptions = {};
  let port = 0;
  return {
    args: () => args,
    command: () => command,
    config: () => config,
    killed: () => killed,
    options: () => options,
    port: () => port,
    spawn: (spawnedCommand, spawnedArgs, opts) => {
      command = spawnedCommand;
      args = spawnedArgs;
      options = opts;
      const configPath = spawnedArgs[spawnedArgs.indexOf('--mcp-config') + 1] ?? '';
      config = readFileSync(configPath, 'utf8');
      const baseUrl = opts.env?.ANTHROPIC_BASE_URL ?? '';
      port = Number(new URL(baseUrl).port);
      onSpawn?.();
      void (async () => {
        try {
          await fetch(`${baseUrl}/api/hello`, { method: 'HEAD' });
          for (const body of bodies) {
            await fetch(`${baseUrl}/v1/messages?beta=true`, {
              body: JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
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

/** Installed-Claude exec seam: version capture stays real to the adapter, process behavior is scripted. */
function claudeCodeExec(
  spawn: Exec['spawn'],
  version: Partial<ExecResult> = { stdout: '2.1.231 (Claude Code)\n' },
  captureCalls: [string, string[]][] = [],
): Exec {
  return {
    capture: (command, args) => {
      captureCalls.push([command, args]);
      return Promise.resolve({ ...EXEC_DEFAULT, ...version });
    },
    spawn,
  };
}

describe('claude-code', () => {
  const TARGET_TOOL = {
    description: 'Echo.',
    input_schema: {
      properties: { message: { description: 'Message.', type: 'string' } },
      required: ['message'],
      type: 'object',
    },
    name: 'mcp__target__echo_message',
  };

  test('rejects streamable-http targets', () => {
    expect(claudeCodeAdapter.supports({ kind: 'http', url: 'https://example.com/mcp' })).toContain(
      'stdio',
    );
  });

  test('adapter-broken: the installed version does not satisfy --pin', async () => {
    const result = await claudeCodeAdapter.run(
      context(
        claudeCodeExec(() => {
          throw new Error('a mismatched pin must not spawn Claude Code');
        }),
        { pins: { 'claude-code': '2.1.230' } },
      ),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.resolvedVersion).toBe('2.1.231');
    expect(result.statusDetail).toContain('does not match requested pin 2.1.230');
  });

  test('adapter-broken: the installed executable cannot report a version', async () => {
    const result = await claudeCodeAdapter.run(
      context(
        claudeCodeExec(
          () => {
            throw new Error('a missing executable must not spawn');
          },
          { code: null, stderr: 'spawn claude ENOENT' },
        ),
      ),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toContain('spawn claude ENOENT');
  });

  test('adapter-broken: claude exited before issuing a tools-bearing request', async () => {
    let killed = 0;
    const result = await claudeCodeAdapter.run(
      context(
        claudeCodeExec(() =>
          managed({ exited: true, onKill: () => (killed += 1), stderr: 'startup failed' }),
        ),
      ),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toContain('startup failed');
    expect(killed).toBe(1);
  });

  test('handshake-failure: the first tools-bearing request has no configured MCP tools', async () => {
    const fake = claudeCodeSpawn([{ tools: [{ input_schema: {}, name: 'Bash' }] }]);
    const result = await claudeCodeAdapter.run(context(claudeCodeExec(fake.spawn)));
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toContain('no MCP tools');
    expect(fake.killed()).toBe(1);
  });

  test('handshake-failure: no tools-bearing request arrives within the budget', async () => {
    const fake = claudeCodeSpawn([{ model: 'claude-opus-5' }]);
    const result = await claudeCodeAdapter.run(
      context(claudeCodeExec(fake.spawn), { timeoutMs: 300 }),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toBe('no tools-bearing model request captured within 300ms');
    expect(fake.killed()).toBe(1);
  });

  test('ok: isolated installed-client capture preserves config, artifacts, and teardown', async () => {
    const artifactsDir = await mkdtemp(join(workDir, 'claude-artifacts-'));
    const body = {
      metadata: { session_id: 'local-sensitive' },
      tools: [{ input_schema: {}, name: 'Bash' }, TARGET_TOOL],
    };
    const captureCalls: [string, string[]][] = [];
    const fake = claudeCodeSpawn([{ model: 'first request has no tools' }, body]);
    try {
      const result = await claudeCodeAdapter.run(
        context(claudeCodeExec(fake.spawn, { stdout: '2.1.231 (Claude Code)\n' }, captureCalls), {
          artifactsDir,
          target: {
            args: ['server.js'],
            command: 'node',
            env: { FIXTURE_TOKEN: 'preserved' },
            kind: 'stdio',
          },
        }),
      );
      expect(result.status).toBe('ok');
      expect(result.resolvedVersion).toBe('2.1.231');
      expect(result.surface?.tools.map((tool) => tool.name)).toEqual(['echo_message']);
      expect(result.canary).toEqual({
        attempted: false,
        detail: 'claude-code adapter is capture-only',
        ok: null,
      });
      expect(captureCalls).toEqual([['claude', ['--version']]]);
      expect(fake.command()).toBe('claude');
      expect(fake.args()).toEqual([
        '--bare',
        '--strict-mcp-config',
        '--mcp-config',
        expect.any(String),
        '--print',
        'ping',
      ]);
      expect(JSON.parse(fake.config())).toEqual({
        mcpServers: {
          target: {
            args: ['server.js'],
            command: 'node',
            env: { FIXTURE_TOKEN: 'preserved' },
            type: 'stdio',
          },
        },
      });
      expect(fake.options().env?.HOME).toStartWith(workDir);
      expect(fake.options().env?.CLAUDE_CONFIG_DIR).toStartWith(workDir);
      expect(fake.options().env?.ANTHROPIC_API_KEY).toContain('dummy');
      expect(fake.options().env?.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${fake.port()}`);
      expect(fake.options().env?.NO_PROXY).toBe('*');
      expect(fake.options().env?.PATH).toBe(process.env.PATH);
      expect(fake.options().inheritEnv).toBe(false);
      for (const key of [
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_USE_BEDROCK',
        'HTTP_PROXY',
        'HTTPS_PROXY',
      ]) {
        expect(fake.options().env?.[key]).toBeUndefined();
      }
      expect(Object.keys(fake.options().env ?? {}).sort()).toEqual([
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'CLAUDE_CONFIG_DIR',
        'HOME',
        'NO_PROXY',
        'PATH',
      ]);
      expect(fake.killed()).toBe(1);
      expect(
        JSON.parse(await readFile(join(artifactsDir, 'claude-code.request.json'), 'utf8')),
      ).toEqual(body);
      await expect(fetch(`http://127.0.0.1:${fake.port()}/api/hello`)).rejects.toThrow();
    } finally {
      await rm(artifactsDir, { force: true, recursive: true });
    }
  });
});
