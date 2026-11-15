/**
 * @file src/adapters/codex.test.ts
 * Codex adapter tests: the request-body parser against a real Codex CLI
 * 0.147.0 intercepted request captured 2026-08-09, status classification
 * driven through a fake `codex exec` that posts to the adapter's real loopback
 * intercept, the package-runner calls (version prime, npm cache, launch), and
 * the rename model pinned to names measured against Codex 0.169.0.
 */
import { describe, expect, test } from 'bun:test';
import { spawn as spawnChild } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EXAMPLE_TOOLS,
  exampleGroundTruth,
  loadFixture,
} from '../../tests/helpers/captured-fixtures.js';
import { expectLinearCpuTime } from '../../tests/helpers/cpu-scaling.js';
import { fakeCodexClient } from '../../tests/helpers/fake-clients.js';
import {
  adapterHarness,
  type CaptureCall,
  codexExec,
  managed,
  NPM_INSTALL_FAILURE,
} from '../../tests/helpers/fake-exec.js';
import { compareSurface } from '../invariants.js';
import { createRedactor } from '../redact.js';
import { renderedToolFromJsonSchema } from '../schema.js';
import type { AdapterContext, GroundTruthTool, ToolRenameMap } from '../types.js';
import { createNodeExec, type Exec } from '../util/exec.js';
import { codexAdapter, codexToolRenames, surfaceFromCodexBody } from './codex.js';

const { context, workDir } = adapterHarness('crosscheck-codex-');

/** What the adapter has always reported for a capture that carried no MCP tools. */
const NO_MCP_TOOLS =
  'model request captured but it carried no MCP tools — the server may have failed to start under codex';
const CAPTURE_ONLY = { attempted: false, detail: 'codex adapter is capture-only', ok: null };
const ECHO_NAMESPACE = {
  name: 'mcp__target',
  tools: [{ name: 'echo', parameters: { type: 'object' } }],
  type: 'namespace',
};

describe('surfaceFromCodexBody', () => {
  const fixture = loadFixture('codex-request.json');
  const surface = surfaceFromCodexBody(fixture);

  test('the frozen request fixture retains only its parser-relevant tools payload', () => {
    expect(Object.keys(fixture as Record<string, unknown>)).toEqual(['tools']);
  });

  test('unwraps the mcp__ namespace and excludes codex-native tools', () => {
    expect(surface).not.toBeNull();
    expect(surface?.tools.map((tool) => tool.name).sort()).toEqual(EXAMPLE_TOOLS);
  });

  test('keeps types, descriptions, and enum; codex strips minimum/maximum', () => {
    const echo = surface?.tools.find((tool) => tool.name === 'template_echo_message');
    const message = echo?.properties.find((property) => property.name === 'message');
    const mode = echo?.properties.find((property) => property.name === 'mode');
    expect(message?.type).toBe('string');
    expect(message?.description).not.toBeNull();
    expect(mode?.constraints.enum).toBeDefined();

    const catFact = surface?.tools.find((tool) => tool.name === 'template_cat_fact');
    const maxLength = catFact?.properties.find((property) => property.name === 'maxLength');
    expect(maxLength?.constraints.minimum).toBeUndefined();
    expect(maxLength?.constraints.maximum).toBeUndefined();
  });

  test('diff against ground truth yields info-only findings', () => {
    const findings = compareSurface(exampleGroundTruth.tools, surface ?? { tools: [] });
    expect(findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
    expect(findings.every((finding) => finding.rule === 'constraint-dropped')).toBe(true);
  });

  test('parses the older flat mcp__target__ function form', () => {
    const flat = {
      tools: [
        {
          name: 'mcp__target__echo',
          parameters: { properties: { m: { type: 'string' } }, type: 'object' },
          type: 'function',
        },
      ],
    };
    const parsed = surfaceFromCodexBody(flat);
    expect(parsed?.tools[0]?.name).toBe('echo');
  });

  test('codex renders no output surface — its tool entries carry input parameters only', () => {
    expect(surface?.tools.every((tool) => tool.outputProperties === undefined)).toBe(true);
    const findings = compareSurface(exampleGroundTruth.tools, surface ?? { tools: [] });
    expect(findings.some((finding) => finding.rule === 'output-schema-divergence')).toBe(false);
  });

  test('returns null for bodies without MCP tools', () => {
    expect(
      surfaceFromCodexBody({ tools: [{ name: 'exec_command', type: 'function' }] }),
    ).toBeNull();
    expect(surfaceFromCodexBody({})).toBeNull();
    expect(surfaceFromCodexBody('nope')).toBeNull();
  });

  test('keeps returning the readable tools of a body that also holds an unreadable one', () => {
    const parsed = surfaceFromCodexBody({
      tools: [{ ...ECHO_NAMESPACE, tools: [...ECHO_NAMESPACE.tools, { name: 7 }] }],
    });
    expect(parsed?.tools.map((tool) => tool.name)).toEqual(['echo']);
  });
});

/** Run the adapter with the fake `codex exec` posting `bodies`, over the default package-runner answers. */
async function runWithBodies(bodies: unknown[], overrides: Partial<AdapterContext> = {}) {
  const fake = fakeCodexClient(bodies);
  const result = await codexAdapter.run(context(codexExec(fake.spawn), overrides));
  return { fake, result };
}

describe('codex', () => {
  test('supports streamable-http targets', () => {
    expect(
      codexAdapter.supports({ headers: {}, kind: 'http', url: 'https://example.com/mcp' }),
    ).toBe(true);
  });

  test('adapter-broken: codex exited before issuing a model request', async () => {
    const result = await codexAdapter.run(
      context(codexExec(() => managed({ exited: true, stderr: NPM_INSTALL_FAILURE }))),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toContain('npm ERR! code E404');
    expect(result.statusDetail).not.toContain('resolving package dependency 0');
  });

  test('ok with an empty surface and the empty-capture marker: the captured request carried no MCP tools', async () => {
    const { fake, result } = await runWithBodies([
      { tools: [{ name: 'shell', type: 'function' }] },
    ]);
    expect(result).toEqual({
      adapter: 'codex',
      canary: CAPTURE_ONLY,
      durationMs: expect.any(Number),
      emptyCapture: { detail: NO_MCP_TOOLS },
      resolvedVersion: '0.147.0-alpha.6.5',
      status: 'ok',
      statusDetail: null,
      surface: { tools: [] },
    });
    expect(fake.killed()).toBe(1);
  });

  test('an MCP namespace with no tools in it is an empty capture too', async () => {
    const { result } = await runWithBodies([{ tools: [{ ...ECHO_NAMESPACE, tools: [] }] }]);
    expect([result.status, result.surface, result.emptyCapture]).toEqual([
      'ok',
      { tools: [] },
      { detail: NO_MCP_TOOLS },
    ]);
  });

  test('handshake-failure: nothing was captured within the budget', async () => {
    const result = await codexAdapter.run(
      context(
        codexExec(() => managed({})),
        { timeoutMs: 300 },
      ),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toBe('no model request captured within 300ms');
  });

  test('ok: the intercepted namespace becomes the rendered surface', async () => {
    const fake = fakeCodexClient([
      {
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
      },
    ]);
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
      .run(context(codexExec(fake.spawn), { timeoutMs }))
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

  test('the intercept answers every request 200 with an empty JSON object, and the run closes it and kills codex once', async () => {
    const { fake, result } = await runWithBodies([
      { input: 'warm-up' },
      { tools: [ECHO_NAMESPACE] },
    ]);
    expect(result.status).toBe('ok');
    expect(fake.replies()[0]).toEqual({
      body: '{}',
      contentType: 'application/json',
      status: 200,
    });
    expect(fake.killed()).toBe(1);
    await expect(fetch(`http://127.0.0.1:${fake.port()}/v1/responses`)).rejects.toThrow();
  });

  test('a stdio config carries only the command line it was handed, as valid TOML', async () => {
    const args = ['/opt/launch target.js', '/tmp/dir with "quotes"/target-launch.json', 'ü\\n'];
    const { fake, result } = await runWithBodies([{ tools: [ECHO_NAMESPACE] }], {
      target: { args, command: '/usr/bin/node', kind: 'stdio' },
    });
    expect(result.status).toBe('ok');
    const parsed = Bun.TOML.parse(fake.config()) as { mcp_servers: Record<string, unknown> };
    expect(parsed.mcp_servers).toEqual({ target: { args, command: '/usr/bin/node' } });
  });

  test('streamable-http config uses url and environment-backed headers without secrets', async () => {
    const artifactsDir = await mkdtemp(join(workDir(), 'codex-http-artifacts-'));
    const fake = fakeCodexClient([{ tools: [ECHO_NAMESPACE] }]);
    const secret = 'dummy-secret-value';
    try {
      const result = await codexAdapter.run(
        context(codexExec(fake.spawn), {
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
        npm_config_cache: '/fake/caller/.npm',
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
    const { fake, result } = await runWithBodies([{ tools: [ECHO_NAMESPACE] }], {
      target: { headers: {}, kind: 'http', url: 'http://127.0.0.1:9000/mcp' },
    });
    expect(result.status).toBe('ok');
    expect(fake.config()).toContain('[mcp_servers.target]\nurl = "http://127.0.0.1:9000/mcp"\n');
    expect(fake.config()).not.toContain('env_http_headers');
  });
});

describe('codex: unreadable MCP entries', () => {
  const UNREADABLE: [string, unknown[]][] = [
    [
      'a namespaced tool with no string name, beside a readable one',
      [{ ...ECHO_NAMESPACE, tools: [...ECHO_NAMESPACE.tools, { parameters: {} }] }],
    ],
    [
      'a namespaced tool whose parameters are not an object',
      [{ ...ECHO_NAMESPACE, tools: [{ name: 'files_read', parameters: [] }] }],
    ],
    ['a namespace whose tools are not a list', [{ ...ECHO_NAMESPACE, tools: 'echo' }]],
    [
      'a flat mcp__target__ entry with a non-string description',
      [{ description: 3, name: 'mcp__target__echo', type: 'function' }],
    ],
  ];

  for (const [name, tools] of UNREADABLE) {
    test(`capture-failure: ${name}`, async () => {
      const { result } = await runWithBodies([
        { tools: [{ name: 'shell', type: 'function' }, ...tools] },
      ]);
      expect([result.status, result.surface, result.canary, result.emptyCapture]).toEqual([
        'capture-failure',
        null,
        null,
        undefined,
      ]);
      expect(result.statusDetail).toStartWith('model request captured but ');
      expect(result.statusDetail).toContain('could not be read');
    });
  }

  test('the detail names each unreadable entry', async () => {
    const { result } = await runWithBodies([
      {
        tools: [
          {
            ...ECHO_NAMESPACE,
            tools: [{ name: 'good', parameters: {} }, { name: 'bad', parameters: 1 }, 5],
          },
          { name: 'mcp__target__flat', parameters: 'x', type: 'function' },
        ],
      },
    ]);
    expect(result.statusDetail).toBe(
      'model request captured but 3 MCP tool entries in it could not be read: "mcp__target" tool "bad", "mcp__target" entry 2, "mcp__target__flat"',
    );
  });

  test('entries outside the MCP selection are not read at all', async () => {
    const { result } = await runWithBodies([
      {
        tools: [
          { description: 3, name: 'mcp__other__echo', type: 'function' },
          { name: 'shell', parameters: [] },
          ECHO_NAMESPACE,
        ],
      },
    ]);
    expect(result.status).toBe('ok');
    expect(result.surface?.tools.map((tool) => tool.name)).toEqual(['echo']);
  });
});

describe('codex: package runner', () => {
  const PIN = '0.147.0-alpha.6.5';
  const PINNED_SPEC = `@openai/codex@${PIN}`;

  async function runRecorded(
    answers: Parameters<typeof codexExec>[1],
    overrides: Partial<AdapterContext> = {},
  ) {
    const calls: CaptureCall[] = [];
    const fake = fakeCodexClient([{ tools: [ECHO_NAMESPACE] }]);
    const result = await codexAdapter.run(
      context(codexExec(fake.spawn, answers, calls), overrides),
    );
    return {
      calls: calls.map(({ args, command }) => [command, ...args]),
      fake,
      raw: calls,
      result,
    };
  }

  test('pinned: one version prime with the caller environment, then the npm cache lookup, then the launch, all on the pin', async () => {
    const { calls, fake, raw, result } = await runRecorded({});
    expect(calls).toEqual([
      ['npx', '-y', PINNED_SPEC, '--version'],
      ['npm', 'config', 'get', 'cache'],
    ]);
    for (const call of raw) {
      expect(call.options.cwd).toBe(workDir());
      expect(call.options.env).toBeUndefined();
      expect(call.options.inheritEnv).toBeUndefined();
    }
    expect(fake.command()).toBe('npx');
    expect(fake.args()).toEqual(['-y', PINNED_SPEC, 'exec', '--skip-git-repo-check', 'ping']);
    expect(result.resolvedVersion).toBe(PIN);
  });

  test('unpinned: resolves latest once and runs that exact release for the prime and the launch', async () => {
    const { calls, fake, result } = await runRecorded(
      { prime: { stdout: 'codex-cli 0.170.0\n' } },
      { pins: {} },
    );
    expect(calls).toEqual([
      ['npm', 'view', '@openai/codex', 'version'],
      ['npx', '-y', '@openai/codex@0.169.0', '--version'],
      ['npm', 'config', 'get', 'cache'],
    ]);
    expect(fake.args().slice(0, 2)).toEqual(['-y', '@openai/codex@0.169.0']);
    // The registry's answer is the release both calls ran; the prime's output is only a fallback.
    expect(result.resolvedVersion).toBe('0.169.0');
  });

  test('unpinned with no registry answer: both calls run @latest and the prime reports the version', async () => {
    const { calls, fake, result } = await runRecorded(
      { prime: { stdout: 'codex-cli 0.171.2\n' }, registry: { code: 1, stdout: '' } },
      { pins: {} },
    );
    expect(calls[1]).toEqual(['npx', '-y', '@openai/codex@latest', '--version']);
    expect(fake.args().slice(0, 2)).toEqual(['-y', '@openai/codex@latest']);
    expect(result.resolvedVersion).toBe('0.171.2');
  });

  test('unpinned with neither a registry answer nor a version in the prime output: version unresolved', async () => {
    const { result } = await runRecorded(
      { prime: { code: 1, stdout: '' }, registry: { stdout: '' } },
      { pins: {} },
    );
    expect([result.status, result.resolvedVersion]).toEqual(['ok', null]);
  });

  test('the launch environment is the isolated set plus only the caller npm cache', async () => {
    const ambient = {
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      HTTP_PROXY: 'http://proxy.invalid:3128',
      // Keeps the fake client's own loopback requests off the ambient proxy.
      NO_PROXY: '127.0.0.1',
      OPENAI_API_KEY: 'sk-ambient',
      npm_config_userconfig: '/caller/.npmrc',
    };
    const saved = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
    Object.assign(process.env, ambient);
    try {
      const { fake } = await runRecorded({ cache: { stdout: '  /Users/someone/.npm  \n' } });
      expect(fake.options().inheritEnv).toBe(false);
      expect(fake.options().env).toEqual({
        CODEX_HOME: expect.stringContaining(workDir()),
        HOME: expect.stringContaining(workDir()),
        NO_PROXY: '*',
        PATH: process.env.PATH as string,
        npm_config_cache: '/Users/someone/.npm',
      });
      expect(fake.options().env?.HOME).toBe(fake.options().env?.CODEX_HOME as string);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('adapter-broken without a launch: the npm cache directory cannot be read', async () => {
    const { fake, result } = await runRecorded({
      cache: { code: 1, stderr: 'npm ERR! config broken' },
    });
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toBe(
      "could not read npm's cache directory with npm config get cache — npm ERR! config broken",
    );
    expect(fake.command()).toBe('');
  });

  test('adapter-broken without a launch: npm prints no cache directory', async () => {
    const { result } = await runRecorded({ cache: { stdout: '\n' } });
    expect(result.statusDetail).toBe(
      "could not read npm's cache directory with npm config get cache — npm config get cache exited with code 0 and printed nothing",
    );
  });

  test('adapter-broken without a launch: npx is not on PATH, named with what provides it', async () => {
    const { calls, fake, result } = await runRecorded({
      prime: { code: null, spawnErrorCode: 'ENOENT', stderr: 'Error: spawn npx ENOENT' },
    });
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toBe(
      'codex could not start — npx is not on PATH; it ships with npm, part of Node.js (Error: spawn npx ENOENT)',
    );
    expect(calls).toHaveLength(1);
    expect(fake.command()).toBe('');
  });
});

describe('codex: a launch that cannot start', () => {
  test('a throwing spawn propagates, and the intercept is closed behind it', async () => {
    let port = '';
    const exec = codexExec((_command, _args, opts) => {
      const config = readFileSync(join(opts.env?.CODEX_HOME ?? '', 'config.toml'), 'utf8');
      port = /127\.0\.0\.1:(\d+)/.exec(config)?.[1] ?? '';
      throw new Error('spawn exploded before the child existed');
    });
    await expect(codexAdapter.run(context(exec))).rejects.toThrow(
      'spawn exploded before the child existed',
    );
    expect(port).not.toBe('');
    await expect(fetch(`http://127.0.0.1:${port}/v1/responses`)).rejects.toThrow();
  });

  test('ENOENT through the real seam names npx and what provides it', async () => {
    const missing = join(workDir(), 'no-such-npx');
    const real = createNodeExec({
      spawn: (_command, args, options) => spawnChild(missing, args, options),
    });
    const result = await codexAdapter.run(context(codexExec(real.spawn)));
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toStartWith(
      'codex could not start — npx is not on PATH; it ships with npm, part of Node.js (',
    );
    expect(result.statusDetail).toContain('ENOENT');
  });

  test('another synchronous spawn refusal keeps the spawn error text', async () => {
    const real = createNodeExec({
      spawn: () => {
        throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG', syscall: 'spawn' });
      },
    });
    const result = await codexAdapter.run(context(codexExec(real.spawn)));
    expect([result.status, result.statusDetail]).toEqual([
      'adapter-broken',
      'codex could not start — Error: spawn E2BIG',
    ]);
  });
});

describe('codex: header values are redacted before a detail is shortened', () => {
  const straddling = 'tok_9f8e7d6c5b4a39281706';
  const tabbed = 'Bearer\tabc123';
  const target = {
    headers: { Authorization: tabbed, 'X-Token': straddling },
    kind: 'http',
    url: 'http://127.0.0.1:9000/mcp',
  } as const;
  const redact = createRedactor([straddling, tabbed]);
  /** Text whose 400-character excerpt cuts the straddling value in half. */
  const cutText = `${'x'.repeat(390)} ${straddling} tail`;
  const tabText = `error: upstream rejected Authorization ${tabbed}`;

  /** Each excerpt site, driven to report `text`. */
  const SITES: [string, (text: string) => Exec][] = [
    ['the launch exit', (text) => codexExec(() => managed({ exited: true, stderr: text }))],
    [
      'a launch that cannot start',
      (text) => codexExec(() => managed({ spawnErrorCode: 'EACCES', stderr: text })),
    ],
    [
      'a version prime that cannot start',
      (text) =>
        codexExec(() => managed({}), {
          prime: { code: null, spawnErrorCode: 'ENOENT', stderr: text },
        }),
    ],
    [
      'the npm cache lookup',
      (text) => codexExec(() => managed({}), { cache: { code: 1, stderr: text } }),
    ],
  ];

  for (const [site, exec] of SITES) {
    test(`${site}: a value cut by the excerpt leaves no prefix`, async () => {
      const result = await codexAdapter.run(context(exec(cutText), { redact, target }));
      expect(result.status).toBe('adapter-broken');
      expect(result.statusDetail).toContain(' [REDACTED');
      expect(result.statusDetail).not.toContain(straddling.slice(0, 5));
    });

    test(`${site}: a value holding a tab is redacted before whitespace is normalized`, async () => {
      const result = await codexAdapter.run(context(exec(tabText), { redact, target }));
      expect(result.statusDetail).toContain('Authorization [REDACTED]');
      expect(result.statusDetail).not.toContain('abc123');
    });
  }
});

describe('codex rename model', () => {
  const renames = (names: string[]): ToolRenameMap =>
    codexAdapter.toolRenames?.(names) ?? new Map();
  const IDENTITY = (name: string) => `target\0target\0\0${name}\0${name}`;
  const sha12 = (input: string) => createHash('sha1').update(input).digest('hex').slice(0, 12);

  test('Codex 0.169.0: dotted and kebab-case names are sanitized; a plain name renders as it is', () => {
    expect([...renames(['files.read', 'get-weather', 'plain_tool'])]).toEqual([
      ['files.read', { change: 'sanitized', kind: 'renamed', rendered: 'files_read' }],
      ['get-weather', { change: 'sanitized', kind: 'renamed', rendered: 'get_weather' }],
    ]);
  });

  test('Codex 0.169.0: every tool of a collision group is hashed, the unsanitized one included', () => {
    expect(renames(['files.read', 'files_read'])).toEqual(
      new Map([
        ['files.read', { change: 'hashed', kind: 'renamed', rendered: 'files_read_a5853431b20f' }],
        ['files_read', { change: 'hashed', kind: 'renamed', rendered: 'files_read_2505a6bf744b' }],
      ]),
    );
    const triple = renames(['a-b', 'a.b', 'a_b']);
    expect([...triple.keys()].sort()).toEqual(['a-b', 'a.b', 'a_b']);
    const rendered = [...triple.values()].map((rename) =>
      rename.kind === 'renamed' ? [rename.change, rename.rendered] : [],
    );
    for (const [change, name] of rendered) {
      expect(change).toBe('hashed');
      expect(name).toMatch(/^a_b_[0-9a-f]{12}$/);
    }
    expect(new Set(rendered.map(([, name]) => name)).size).toBe(3);
  });

  test('a repeated name is one tool, not a collision', () => {
    expect([...renames(['files.read', 'files.read'])]).toEqual([
      ['files.read', { change: 'sanitized', kind: 'renamed', rendered: 'files_read' }],
    ]);
  });

  test('Codex 0.169.0: 115 characters fit beside mcp__target; 116 are cut to 102 plus a hash', () => {
    const fits = 'a'.repeat(115);
    const long = `${'b'.repeat(100)}.${'c'.repeat(15)}`;
    const result = renames([fits, long]);
    expect(result.has(fits)).toBe(false);
    const rename = result.get(long);
    expect(rename).toEqual({
      change: 'hashed',
      kind: 'renamed',
      rendered: `${'b'.repeat(100)}_c_${sha12(IDENTITY(long))}`,
    });
    expect(rename?.kind === 'renamed' ? rename.rendered.length : 0).toBe(115);
  });

  test('a hashed name already taken retries with the attempt counter in the hash input', () => {
    const long = 'z'.repeat(116);
    // Sorts before `long` (`_` < `z`) and is exactly what attempt 0 would render it as.
    const taken = `${'z'.repeat(102)}_${sha12(IDENTITY(long))}`;
    expect([...renames([long, taken])]).toEqual([
      [
        long,
        {
          change: 'hashed',
          kind: 'renamed',
          rendered: `${'z'.repeat(102)}_${sha12(`${IDENTITY(long)}\u00001`)}`,
        },
      ],
    ]);
  });

  test('non-ASCII: each Unicode scalar outside [A-Za-z0-9_] becomes one underscore; an empty name becomes one', () => {
    expect(renames(['é.x', '😀x', ''])).toEqual(
      new Map([
        ['é.x', { change: 'sanitized', kind: 'renamed', rendered: '__x' }],
        ['😀x', { change: 'sanitized', kind: 'renamed', rendered: '_x' }],
        ['', { change: 'sanitized', kind: 'renamed', rendered: '_' }],
      ]),
    );
  });

  test('names are claimed in code-point order of their raw identity, not UTF-16 order', () => {
    // U+FF0E sorts before U+1F600 by code point (Rust's byte order) and after it by UTF-16 unit.
    const long = `x．${'z'.repeat(114)}`;
    const claimed = `x_${'z'.repeat(100)}_${sha12(IDENTITY(long))}`;
    // Sanitizes to exactly the name `long` is cut to, so whichever sorts first takes it.
    const rival = `x😀${claimed.slice(2)}`;
    const result = renames([rival, long]);
    expect(result.get(long)).toEqual({ change: 'hashed', kind: 'renamed', rendered: claimed });
    expect(result.get(rival)).toEqual({
      change: 'hashed',
      kind: 'renamed',
      rendered: `${claimed.slice(0, 102)}_${sha12(IDENTITY(rival))}`,
    });
  });

  test('the model costs time linear in a name, whatever its characters', () => {
    // Both scans are one pass over the name with no regex: no input shape can make them backtrack.
    const shapes: ((size: number) => string)[] = [
      (size) => `${'_'.repeat(size - 1)}x`,
      (size) => 'é.'.repeat(size / 2),
      (size) => '😀'.repeat(size / 2),
    ];
    for (const shape of shapes) expectLinearCpuTime(shape, (name) => codexToolRenames([name]));
  });

  test('the adapter carries the exported model as its rename hook', () => {
    expect(codexAdapter.toolRenames).toBe(codexToolRenames);
  });

  test('a constraint dropped on a renamed tool is reported against its ground-truth path', () => {
    const files: GroundTruthTool = {
      description: 'Read.',
      inputSchema: {
        properties: { path: { maxLength: 9, type: 'string' } },
        type: 'object',
      },
      name: 'files.read',
    };
    const rendered = renderedToolFromJsonSchema('files_read', 'Read.', {
      properties: { path: { type: 'string' } },
      type: 'object',
    });
    const findings = compareSurface([files], { tools: [rendered] }, renames(['files.read']));
    expect(findings.map((finding) => [finding.rule, finding.path, finding.severity])).toEqual([
      ['tool-renamed', 'files.read', 'info'],
      ['constraint-dropped', 'files.read.path', 'info'],
    ]);
  });
});
