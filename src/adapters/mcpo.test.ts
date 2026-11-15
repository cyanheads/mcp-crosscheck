/**
 * @file src/adapters/mcpo.test.ts
 * mcpo adapter tests: the OpenAPI parser against a real mcpo 0.0.20
 * openapi.json captured 2026-08-09, and status classification and argv shape
 * driven through a fake `uvx mcpo` that serves a document on the port it is
 * told to use (the adapter's readiness polling stays real). The PyPI lookup an
 * unpinned run makes is answered by a `fetch` stub; no test reaches a registry.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXAMPLE_TOOLS,
  exampleGroundTruth,
  loadFixture,
} from '../../tests/helpers/captured-fixtures.js';
import {
  adapterHarness,
  managed,
  RICH_IMPORT_FAILURE,
  spawnExec,
} from '../../tests/helpers/fake-exec.js';
import { compareSurface } from '../invariants.js';
import { createRedactor } from '../redact.js';
import type { Exec, SpawnOptions } from '../util/exec.js';
import { mcpoAdapter, surfaceFromOpenApiDoc } from './mcpo.js';

const { context, workDir } = adapterHarness('crosscheck-mcpo-');

describe('surfaceFromOpenApiDoc', () => {
  const surface = surfaceFromOpenApiDoc(loadFixture('mcpo-openapi.json'));

  test('maps every post route to a tool', () => {
    expect(surface).not.toBeNull();
    expect(surface?.tools.map((tool) => tool.name).sort()).toEqual(EXAMPLE_TOOLS);
  });

  test('resolves form-model $refs into typed, described properties', () => {
    const echo = surface?.tools.find((tool) => tool.name === 'template_echo_message');
    expect(echo?.description).not.toBeNull();
    const message = echo?.properties.find((property) => property.name === 'message');
    expect(message?.type).toBe('string');
    expect(message?.description).not.toBeNull();
    expect(echo?.requiredNames).toContain('message');
  });

  test('mcpo strips enum and numeric bounds (recorded as info by the engine)', () => {
    const echo = surface?.tools.find((tool) => tool.name === 'template_echo_message');
    const mode = echo?.properties.find((property) => property.name === 'mode');
    expect(mode?.constraints.enum).toBeUndefined();

    const findings = compareSurface(exampleGroundTruth.tools, surface ?? { tools: [] });
    expect(findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
    expect(findings.some((finding) => finding.detail.includes('enum'))).toBe(true);
    expect(findings.every((finding) => finding.rule === 'constraint-dropped')).toBe(true);
  });

  test('the anyOf response envelope becomes the rendered result model', () => {
    // mcpo wraps the generated model in `{anyOf: [{$ref: ...}, {}]}`; the union
    // branch is where every output field lives.
    const explorer = surface?.tools.find((tool) => tool.name === 'template_data_explorer');
    expect(explorer?.outputProperties?.map((property) => property.name)).toEqual([
      'rows',
      'generatedAt',
      'summary',
    ]);
    const generatedAt = explorer?.outputProperties?.find(
      (property) => property.name === 'generatedAt',
    );
    expect(generatedAt?.type).toBe('string');
    expect(generatedAt?.description).not.toBeNull();
  });

  test('response models nest through rows.items and summary', () => {
    const explorer = surface?.tools.find((tool) => tool.name === 'template_data_explorer');
    const rows = explorer?.outputProperties?.find((property) => property.name === 'rows');
    expect(rows?.type).toBe('array');
    expect(rows?.items?.children?.map((child) => child.name)).toEqual([
      'id',
      'region',
      'product',
      'units',
      'revenue',
      'date',
    ]);
    const summary = explorer?.outputProperties?.find((property) => property.name === 'summary');
    expect(summary?.children?.map((child) => child.name)).toEqual([
      'totalRows',
      'totalRevenue',
      'totalUnits',
    ]);
  });

  test('ground truth advertising no output schema yields no output findings', () => {
    const findings = compareSurface(exampleGroundTruth.tools, surface ?? { tools: [] });
    expect(findings.some((finding) => finding.rule === 'output-schema-divergence')).toBe(false);
  });

  test('a null requestBody renders as an empty surface the engine can flag', () => {
    const doc = {
      paths: { '/broken_tool': { post: { description: 'Broken.', requestBody: null } } },
    };
    const parsed = surfaceFromOpenApiDoc(doc);
    expect(parsed?.tools[0]?.properties).toEqual([]);
  });

  test('returns null for non-OpenAPI documents', () => {
    expect(surfaceFromOpenApiDoc({ nope: true })).toBeNull();
    expect(surfaceFromOpenApiDoc(null)).toBeNull();
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

/** How the fake proxy answers, and what it records. */
interface FakeProxy {
  /** The response to every tool POST; 200 `{"result":"ok"}` by default. */
  canary?: { body: string; status: number };
  /** The status `openapi.json` is served with; 200 by default. */
  documentStatus?: number;
  /** Incremented for each `openapi.json` request served. */
  served?: { documents: number };
  /** The options of each spawn. */
  spawned?: SpawnOptions[];
}

/** Fake `uvx mcpo` that serves a document on the port it was told to listen on. */
function openApiSpawn(document: string, calls?: string[][], proxy: FakeProxy = {}): Exec['spawn'] {
  return (_command, args, opts) => {
    calls?.push(args);
    proxy.spawned?.push(opts);
    const port = Number(args[args.indexOf('--port') + 1]);
    const server = http.createServer((request, response) => {
      if (request.url === '/openapi.json') {
        if (proxy.served !== undefined) proxy.served.documents += 1;
        response.writeHead(proxy.documentStatus ?? 200, { 'content-type': 'application/json' });
        response.end(document);
        return;
      }
      response.writeHead(proxy.canary?.status ?? 200, { 'content-type': 'application/json' });
      response.end(proxy.canary?.body ?? '{"result":"ok"}');
    });
    server.listen(port, '127.0.0.1');
    return managed({ onKill: () => server.close() });
  };
}

/**
 * Route `fetch` through `intercept` while `run` runs: a request it answers (a
 * non-null result) never leaves the process; any other goes out unchanged.
 */
async function withFetch<T>(
  intercept: (url: string) => Promise<Response> | null,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const routed = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    intercept(input instanceof Request ? input.url : String(input)) ?? original(input, init);
  const spy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(routed, { preconnect: original.preconnect }),
  );
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

/** Answer PyPI's JSON API with `respond()` while `run` runs, recording each lookup URL. */
async function withPypi<T>(
  respond: () => Response,
  run: (lookups: string[]) => Promise<T>,
): Promise<T> {
  const lookups: string[] = [];
  return withFetch(
    (url) => {
      if (!url.startsWith('https://pypi.org/')) return null;
      lookups.push(url);
      return Promise.resolve(respond());
    },
    () => run(lookups),
  );
}

/** The `--with` flags of an mcpo argv: everything before the package spec. */
function withFlags(args: string[]): string[] {
  return args.slice(
    0,
    args.findIndex((arg) => arg.startsWith('mcpo')),
  );
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

  test('capture-failure: openapi.json is served but is not a document', async () => {
    for (const document of ['"not a document"', 'Ünavailable', '{"openapi":"3.1.0"}']) {
      const result = await mcpoAdapter.run(context(spawnExec(openApiSpawn(document))));
      expect(result.status).toBe('capture-failure');
      expect(result.statusDetail).toBe(
        `openapi.json was not an OpenAPI document (${Buffer.byteLength(document)} bytes)`,
      );
      expect(result.surface).toBeNull();
    }
  });

  test('handshake-failure: openapi.json answered with an error status, which ends the wait', async () => {
    const result = await mcpoAdapter.run(
      context(
        spawnExec(openApiSpawn('Internal Server Error', undefined, { documentStatus: 500 })),
        { timeoutMs: 2_000 },
      ),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toBe('openapi.json returned HTTP 500 — Internal Server Error');
  });

  test('the document the readiness probe received is the surface: openapi.json is fetched once', async () => {
    const served = { documents: 0 };
    const result = await mcpoAdapter.run(
      context(spawnExec(openApiSpawn(OPENAPI_DOC, undefined, { served }))),
    );
    expect(result.status).toBe('ok');
    expect(served.documents).toBe(1);
  });

  test('adapter-broken: uvx is not on PATH, and the detail says what provides it', async () => {
    const result = await mcpoAdapter.run(
      context(
        spawnExec(() => managed({ spawnErrorCode: 'ENOENT', stderr: 'Error: spawn uvx ENOENT' })),
      ),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toBe(
      'uvx is not on PATH — it ships with uv (https://docs.astral.sh/uv/)',
    );
  });

  test('adapter-broken: any other spawn failure keeps the spawn error text', async () => {
    const result = await mcpoAdapter.run(
      context(spawnExec(() => managed({ spawnErrorCode: 'E2BIG', stderr: 'Error: spawn E2BIG' }))),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toBe('uvx could not start — Error: spawn E2BIG');
  });

  test('adapter-broken: a proxy that died silently names its exit code', async () => {
    const result = await mcpoAdapter.run(context(spawnExec(() => managed({ exited: true }))));
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toBe('mcpo exited before becoming ready with exit code 1');
  });

  test('unpinned: latest resolves once from PyPI and the spawn carries exactly that release', async () => {
    const calls: string[][] = [];
    const { lookups, result } = await withPypi(
      () => Response.json({ info: { version: '0.0.21' } }),
      async (lookups) => ({
        lookups,
        result: await mcpoAdapter.run(
          context(spawnExec(openApiSpawn(OPENAPI_DOC, calls)), { pins: {} }),
        ),
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.resolvedVersion).toBe('0.0.21');
    expect(lookups).toEqual(['https://pypi.org/pypi/mcpo/json']);
    expect(calls.map((args) => args.filter((arg) => arg.startsWith('mcpo')))).toEqual([
      ['mcpo@0.0.21'],
    ]);
  });

  test('unpinned with a failed lookup spawns mcpo@latest and reports no version', async () => {
    for (const respond of [
      () => new Response('not found', { status: 404 }),
      () => Response.json({ info: {} }),
    ]) {
      const calls: string[][] = [];
      const result = await withPypi(respond, () =>
        mcpoAdapter.run(context(spawnExec(openApiSpawn(OPENAPI_DOC, calls)), { pins: {} })),
      );
      expect(result.status).toBe('ok');
      expect(result.resolvedVersion).toBeNull();
      expect(calls.map((args) => args.filter((arg) => arg.startsWith('mcpo')))).toEqual([
        ['mcpo@latest'],
      ]);
    }
  });

  test('default constraints ride every run and the log names them', async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    await mcpoAdapter.run(
      context(spawnExec(openApiSpawn(OPENAPI_DOC, calls)), { log: (line) => logs.push(line) }),
    );
    expect(withFlags(calls[0] ?? [])).toEqual(['--with', 'mcp<2', '--with', 'fastapi<0.145']);
    expect(calls[0]).toContain('mcpo@0.0.20');
    const named = logs.filter((line) => line.includes('mcp<2'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('fastapi<0.145');
  });

  test('a --mcpo-with entry naming a defaulted package replaces only that default', async () => {
    const cases: [string[], string[]][] = [
      [['mcp==1.20.0'], ['fastapi<0.145', 'mcp==1.20.0']],
      [['MCP>=1.2,<2'], ['fastapi<0.145', 'MCP>=1.2,<2']],
      [['mcp[cli]<2'], ['fastapi<0.145', 'mcp[cli]<2']],
      [
        ['mcp @ https://example.invalid/mcp.tar.gz'],
        ['fastapi<0.145', 'mcp @ https://example.invalid/mcp.tar.gz'],
      ],
      [['FastAPI<0.120'], ['mcp<2', 'FastAPI<0.120']],
      [['httpx<1'], ['mcp<2', 'fastapi<0.145', 'httpx<1']],
      // PEP 503 normalization keeps distinct projects distinct.
      [
        ['mcp-proxy<1', 'fast_api==1'],
        ['mcp<2', 'fastapi<0.145', 'mcp-proxy<1', 'fast_api==1'],
      ],
      [
        ['fastapi<0.120', 'mcp==1.20.0'],
        ['fastapi<0.120', 'mcp==1.20.0'],
      ],
    ];
    for (const [mcpoWith, expected] of cases) {
      const calls: string[][] = [];
      await mcpoAdapter.run(context(spawnExec(openApiSpawn(OPENAPI_DOC, calls)), { mcpoWith }));
      expect(withFlags(calls[0] ?? [])).toEqual(expected.flatMap((entry) => ['--with', entry]));
    }
  });

  test('with every default replaced, the log names none', async () => {
    const logs: string[] = [];
    await mcpoAdapter.run(
      context(spawnExec(openApiSpawn(OPENAPI_DOC)), {
        log: (line) => logs.push(line),
        mcpoWith: ['mcp==1.20.0', 'fastapi<0.120'],
      }),
    );
    expect(logs.some((line) => line.includes('mcp<2') || line.includes('fastapi<0.145'))).toBe(
      false,
    );
  });

  test('stdio: the proxy starts in the scratch directory with no spawn environment of its own', async () => {
    const spawned: SpawnOptions[] = [];
    const calls: string[][] = [];
    await mcpoAdapter.run(
      context(spawnExec(openApiSpawn(OPENAPI_DOC, calls, { spawned })), {
        target: {
          args: ['/crosscheck/dist/launch-target.js', '/scratch/target-launch.json'],
          command: process.execPath,
          kind: 'stdio',
        },
      }),
    );
    expect(spawned).toEqual([{ cwd: workDir() }]);
    const args = calls[0] ?? [];
    expect(args.slice(args.indexOf('--'))).toEqual([
      '--',
      process.execPath,
      '/crosscheck/dist/launch-target.js',
      '/scratch/target-launch.json',
    ]);
  });

  test('--artifacts saves the served document as mcpo.openapi.json', async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), 'crosscheck-mcpo-artifacts-'));
    try {
      const result = await mcpoAdapter.run(
        context(spawnExec(openApiSpawn(OPENAPI_DOC)), { artifactsDir }),
      );
      expect(result.status).toBe('ok');
      expect(JSON.parse(await readFile(join(artifactsDir, 'mcpo.openapi.json'), 'utf8'))).toEqual(
        JSON.parse(OPENAPI_DOC),
      );
    } finally {
      await rm(artifactsDir, { force: true, recursive: true });
    }
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

describe('mcpo: header values are redacted before the detail is cut', () => {
  const SECRET = 'tok_9f8e7d6c5b4a39281706';
  const SPACED_SECRET = 'Bearer\tabc  123';
  const redact = createRedactor([SECRET, SPACED_SECRET]);
  /** Text that, after `prefix`, puts SECRET across excerpt's 400-character cut, at 391. */
  const straddling = (prefix = '') => `${'x'.repeat(400 - prefix.length - 10)} ${SECRET} tail`;
  const spaced = `error: upstream rejected Authorization ${SPACED_SECRET}`;
  const CANARY = { args: { message: 'probe' }, tool: 'echo_message' };

  /** The marker, whole or cut, and no six-character fragment of either value. */
  function expectRedacted(detail: string | null | undefined): void {
    expect(detail).toContain('[REDACTED');
    for (let start = 0; start + 6 <= SECRET.length; start += 1) {
      expect(detail).not.toContain(SECRET.slice(start, start + 6));
    }
    expect(detail).not.toContain('abc');
  }

  test('a proxy that exited before becoming ready', async () => {
    for (const stderr of [straddling('mcpo exited before becoming ready — '), spaced]) {
      const result = await mcpoAdapter.run(
        context(
          spawnExec(() => managed({ exited: true, stderr })),
          { redact },
        ),
      );
      expectRedacted(result.statusDetail);
    }
  });

  test('a spawn failure', async () => {
    for (const stderr of [straddling('uvx could not start — '), spaced]) {
      const result = await mcpoAdapter.run(
        context(
          spawnExec(() => managed({ spawnErrorCode: 'E2BIG', stderr })),
          { redact },
        ),
      );
      expectRedacted(result.statusDetail);
    }
  });

  test('an error status on openapi.json', async () => {
    for (const body of [straddling('openapi.json returned HTTP 500 — '), spaced]) {
      const result = await mcpoAdapter.run(
        context(spawnExec(openApiSpawn(body, undefined, { documentStatus: 500 })), {
          redact,
          timeoutMs: 2_000,
        }),
      );
      expectRedacted(result.statusDetail);
    }
  });

  test('a canary the proxy answered with an error status', async () => {
    for (const body of [straddling('HTTP 500 — '), spaced]) {
      const result = await mcpoAdapter.run(
        context(
          spawnExec(openApiSpawn(OPENAPI_DOC, undefined, { canary: { body, status: 500 } })),
          {
            canary: CANARY,
            redact,
          },
        ),
      );
      expectRedacted(result.canary?.detail);
    }
  });

  test('a canary request that failed in transport', async () => {
    // `Error: …` is error-shaped, so excerpt keeps the end and cuts the start: here, inside SECRET.
    const startStraddling = `${SECRET} ${'x'.repeat(385)}`;
    for (const message of [startStraddling, spaced]) {
      const result = await withFetch(
        (url) => (url.endsWith('/echo_message') ? Promise.reject(new Error(message)) : null),
        () =>
          mcpoAdapter.run(
            context(spawnExec(openApiSpawn(OPENAPI_DOC)), { canary: CANARY, redact }),
          ),
      );
      expectRedacted(result.canary?.detail);
    }
  });
});
