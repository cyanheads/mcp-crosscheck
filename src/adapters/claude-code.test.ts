/**
 * @file src/adapters/claude-code.test.ts
 * Claude Code adapter tests: the request-body parser against a real Claude
 * Code 2.1.231 request captured 2026-08-13 from the bundled fixture server,
 * status classification driven through a fake installed `claude` that probes
 * and posts to the adapter's real loopback intercept, and the rename model
 * pinned to names measured against Claude Code 2.1.325.
 */
import { describe, expect, test } from 'bun:test';
import { spawn as spawnChild } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_TOOLS } from '../../tests/fixture-server/tools.js';
import { loadFixture } from '../../tests/helpers/captured-fixtures.js';
import { expectLinearCpuTime } from '../../tests/helpers/cpu-scaling.js';
import { fakeClaudeCodeClient } from '../../tests/helpers/fake-clients.js';
import { adapterHarness, EXEC_DEFAULT, managed } from '../../tests/helpers/fake-exec.js';
import { compareSurface } from '../invariants.js';
import { createRedactor } from '../redact.js';
import type { AdapterContext, GroundTruthTool, ToolRenameMap } from '../types.js';
import { createNodeExec, type Exec, type ExecResult, nodeExec } from '../util/exec.js';
import {
  claudeCodeAdapter,
  claudeCodeToolRenames,
  surfaceFromClaudeCodeBody,
} from './claude-code.js';

const { context, workDir } = adapterHarness('crosscheck-claude-code-');

const FIXTURE_TOOL_NAMES = FIXTURE_TOOLS.map((tool) => tool.name).sort();
const FIXTURE_GROUND_TRUTH: GroundTruthTool[] = FIXTURE_TOOLS.map((tool) => ({
  description: tool.description ?? null,
  inputSchema: tool.inputSchema,
  name: tool.name,
  ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
}));
/** What the adapter has always reported for a capture that carried no MCP tools. */
const NO_MCP_TOOLS =
  'tools-bearing model request captured but it carried no MCP tools for the configured target';

describe('surfaceFromClaudeCodeBody', () => {
  const fixture = loadFixture('claude-code-request.json');
  const surface = surfaceFromClaudeCodeBody(fixture, 'fixture');

  test('retains only tools while exercising native-tool filtering', () => {
    expect(Object.keys(fixture as Record<string, unknown>)).toEqual(['tools']);
    expect((fixture as { tools: unknown[] }).tools).toHaveLength(9);
    expect(surface?.tools.map((tool) => tool.name).sort()).toEqual(FIXTURE_TOOL_NAMES);
  });

  test('normalizes descriptions, nested input schemas, and constraints', () => {
    const nested = surface?.tools.find((tool) => tool.name === 'nested_config');
    const config = nested?.properties.find((property) => property.name === 'config');
    const transport = config?.children?.find((property) => property.name === 'transport');
    const timeout = transport?.children?.find((property) => property.name === 'timeoutMs');
    expect(nested?.description).not.toBeNull();
    expect(config?.required).toBe(true);
    expect(transport?.requiredNames).toEqual(['timeoutMs']);
    expect(timeout?.type).toBe('integer');
    expect(timeout?.constraints.minimum).toBe(1);
  });

  test('records only the observed root-union flattening and its replaced descriptions', () => {
    const findings = compareSurface(FIXTURE_GROUND_TRUTH, surface ?? { tools: [] });
    const rewritten = { change: 'rewritten', kind: 'description-altered', subject: 'tool' };
    expect(findings).toEqual([
      expect.objectContaining({
        evidence: rewritten,
        path: 'union_modes',
        rule: 'description-altered',
        severity: 'info',
      }),
      expect.objectContaining({ path: 'union_modes', rule: 'anyof-ignored', severity: 'info' }),
      expect.objectContaining({
        evidence: rewritten,
        path: 'branch_only_fields',
        rule: 'description-altered',
        severity: 'info',
      }),
      expect.objectContaining({
        path: 'branch_only_fields',
        rule: 'anyof-ignored',
        severity: 'info',
      }),
    ]);
  });

  test('exposes no rendered output surface', () => {
    expect(surface?.tools.every((tool) => tool.outputProperties === undefined)).toBe(true);
  });

  test('returns null without exact mcp__target__ tool entries', () => {
    expect(surfaceFromClaudeCodeBody({ tools: [{ name: 'Bash', input_schema: {} }] })).toBeNull();
    expect(
      surfaceFromClaudeCodeBody({
        tools: [{ name: 'mcp__other__echo', input_schema: { type: 'object' } }],
      }),
    ).toBeNull();
    expect(surfaceFromClaudeCodeBody({})).toBeNull();
  });

  test('keeps returning the readable tools of a body that also holds an unreadable one', () => {
    const parsed = surfaceFromClaudeCodeBody({
      tools: [
        { input_schema: {}, name: 'mcp__target__echo' },
        { input_schema: [], name: 'mcp__target__broken' },
      ],
    });
    expect(parsed?.tools.map((tool) => tool.name)).toEqual(['echo']);
  });
});

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

/** Run the adapter with the fake `claude` posting `bodies` after its HEAD probe. */
async function runWithBodies(bodies: unknown[], overrides: Partial<AdapterContext> = {}) {
  const fake = fakeClaudeCodeClient(bodies);
  const result = await claudeCodeAdapter.run(context(claudeCodeExec(fake.spawn), overrides));
  return { fake, result };
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
            throw new Error('a broken executable must not spawn');
          },
          { code: 1, stderr: 'claude: unsupported platform' },
        ),
      ),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toBe(
      'installed Claude Code is unavailable — claude: unsupported platform',
    );
  });

  test('adapter-broken: no claude on PATH names the executable the adapter needs', async () => {
    // Real spawning, with a PATH that holds no claude, so the runtime's own ENOENT is what classifies.
    const noClaudeOnPath: Exec = {
      capture: (command, args, opts) =>
        nodeExec.capture(command, args, { ...opts, env: { PATH: workDir() }, inheritEnv: false }),
      spawn: () => {
        throw new Error('a missing executable must not spawn');
      },
    };
    const result = await claudeCodeAdapter.run(context(noClaudeOnPath));
    expect(result.status).toBe('adapter-broken');
    expect(result.resolvedVersion).toBeNull();
    expect(result.statusDetail).toStartWith(
      'installed Claude Code is unavailable — the claude-code adapter needs a claude executable on PATH',
    );
    expect(result.statusDetail).toContain('an npm global install provides only claude.cmd');
  });

  test('adapter-broken: a claude that fails to start for another reason keeps the spawn error', async () => {
    const result = await claudeCodeAdapter.run(
      context(
        claudeCodeExec(
          () => {
            throw new Error('an unlaunchable executable must not spawn');
          },
          { code: null, spawnErrorCode: 'EACCES', stderr: 'Error: spawn claude EACCES' },
        ),
      ),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toBe(
      'installed Claude Code is unavailable — Error: spawn claude EACCES',
    );
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

  test('adapter-broken: a claude launch that never started reports the spawn error, never an exit code', async () => {
    const silent = await claudeCodeAdapter.run(
      context(claudeCodeExec(() => managed({ spawnErrorCode: 'EACCES' }))),
    );
    expect([silent.status, silent.statusDetail]).toEqual([
      'adapter-broken',
      'claude could not start — spawn failed with EACCES',
    ]);

    const missing = join(workDir(), 'no-such-claude');
    const real = createNodeExec({
      spawn: (_command, args, options) => spawnChild(missing, args, options),
    });
    const result = await claudeCodeAdapter.run(context(claudeCodeExec(real.spawn)));
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toStartWith('claude could not start — ');
    expect(result.statusDetail).toContain('ENOENT');
    expect(result.statusDetail).not.toContain('exit code');
  });

  test('ok with an empty surface and the empty-capture marker: the first tools-bearing request has no configured MCP tools', async () => {
    const { fake, result } = await runWithBodies([{ tools: [{ input_schema: {}, name: 'Bash' }] }]);
    expect(result).toEqual({
      adapter: 'claude-code',
      canary: { attempted: false, detail: 'claude-code adapter is capture-only', ok: null },
      durationMs: expect.any(Number),
      emptyCapture: { detail: NO_MCP_TOOLS },
      resolvedVersion: '2.1.231',
      status: 'ok',
      statusDetail: null,
      surface: { tools: [] },
    });
    expect(fake.killed()).toBe(1);
  });

  test('capture-failure: an mcp__target__ entry that cannot be read, even beside a readable one', async () => {
    const { result } = await runWithBodies([
      {
        tools: [
          { input_schema: {}, name: 'Bash' },
          TARGET_TOOL,
          { input_schema: [], name: 'mcp__target__files_read' },
          { description: 4, name: 'mcp__target__get-weather' },
          { input_schema: 'x', name: 'mcp__other__ignored' },
        ],
      },
    ]);
    expect([result.status, result.surface, result.canary, result.emptyCapture]).toEqual([
      'capture-failure',
      null,
      null,
      undefined,
    ]);
    expect(result.statusDetail).toBe(
      'tools-bearing model request captured but 2 MCP tool entries for the configured target could not be read: "mcp__target__files_read", "mcp__target__get-weather"',
    );
  });

  test('handshake-failure: no tools-bearing request arrives within the budget', async () => {
    const fake = fakeClaudeCodeClient([{ model: 'claude-opus-5' }]);
    const result = await claudeCodeAdapter.run(
      context(claudeCodeExec(fake.spawn), { timeoutMs: 300 }),
    );
    expect(result.status).toBe('handshake-failure');
    expect(result.statusDetail).toBe('no tools-bearing model request captured within 300ms');
    expect(fake.killed()).toBe(1);
  });

  test('ok: isolated installed-client capture preserves config, artifacts, and teardown', async () => {
    const artifactsDir = await mkdtemp(join(workDir(), 'claude-artifacts-'));
    const body = {
      metadata: { session_id: 'local-sensitive' },
      tools: [{ input_schema: {}, name: 'Bash' }, TARGET_TOOL],
    };
    const captureCalls: [string, string[]][] = [];
    const fake = fakeClaudeCodeClient([{ model: 'first request has no tools' }, body]);
    try {
      const result = await claudeCodeAdapter.run(
        context(claudeCodeExec(fake.spawn, { stdout: '2.1.231 (Claude Code)\n' }, captureCalls), {
          artifactsDir,
          target: { args: ['server.js'], command: 'node', kind: 'stdio' },
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
      // The command line it was handed, and no env block: the launcher carries the environment.
      expect(JSON.parse(fake.config())).toEqual({
        mcpServers: {
          target: {
            args: ['server.js'],
            command: 'node',
            type: 'stdio',
          },
        },
      });
      expect(fake.options().env?.HOME).toStartWith(workDir());
      expect(fake.options().env?.CLAUDE_CONFIG_DIR).toStartWith(workDir());
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

  test('the intercept answers its HEAD probe 200 and every model request 401, before the capture', async () => {
    const { fake, result } = await runWithBodies([
      { model: 'first request has no tools' },
      { tools: [TARGET_TOOL] },
    ]);
    expect(result.status).toBe('ok');
    expect(fake.replies().slice(0, 2)).toEqual([
      { body: '', contentType: null, status: 200 },
      {
        body: '{"error":{"message":"mcp-crosscheck capture complete","type":"auth_error"}}',
        contentType: 'application/json',
        status: 401,
      },
    ]);
  });
});

describe('claude-code: header values are redacted before a detail is shortened', () => {
  const straddling = 'tok_9f8e7d6c5b4a39281706';
  const tabbed = 'Bearer\tabc123';
  // Stdio targets carry no header values; the redactor is injected to pin the order at each site.
  const redact = createRedactor([straddling, tabbed]);
  /** Text whose 400-character excerpt cuts the straddling value in half. */
  const cutText = `${'x'.repeat(390)} ${straddling} tail`;
  const tabText = `error: upstream rejected Authorization ${tabbed}`;
  const never: Exec['spawn'] = () => {
    throw new Error('this site is reached before any launch');
  };

  /** Each excerpt site, driven to report `text`. */
  const SITES: [string, (text: string) => Exec][] = [
    [
      'claude missing from PATH',
      (text) => claudeCodeExec(never, { code: null, spawnErrorCode: 'ENOENT', stderr: text }),
    ],
    ['claude --version failing', (text) => claudeCodeExec(never, { code: 1, stderr: text })],
    ['the launch exit', (text) => claudeCodeExec(() => managed({ exited: true, stderr: text }))],
    [
      'a launch that cannot start',
      (text) => claudeCodeExec(() => managed({ spawnErrorCode: 'EACCES', stderr: text })),
    ],
  ];

  for (const [site, exec] of SITES) {
    test(`${site}: a value cut by the excerpt leaves no prefix`, async () => {
      const result = await claudeCodeAdapter.run(context(exec(cutText), { redact }));
      expect(result.status).toBe('adapter-broken');
      expect(result.statusDetail).toContain(' [REDACTED');
      expect(result.statusDetail).not.toContain(straddling.slice(0, 5));
    });

    test(`${site}: a value holding a tab is redacted before whitespace is normalized`, async () => {
      const result = await claudeCodeAdapter.run(context(exec(tabText), { redact }));
      expect(result.statusDetail).toContain('Authorization [REDACTED]');
      expect(result.statusDetail).not.toContain('abc123');
    });
  }
});

describe('claude-code rename model', () => {
  const renames = (names: string[]): ToolRenameMap =>
    claudeCodeAdapter.toolRenames?.(names) ?? new Map();
  const SPECIAL = 'claude.ai ';

  test('Claude Code 2.1.325: a dotted name is sanitized; kebab-case and plain names render as they are', () => {
    expect([...renames(['files.read', 'get-weather', 'plain_tool'])]).toEqual([
      ['files.read', { change: 'sanitized', kind: 'renamed', rendered: 'files_read' }],
    ]);
  });

  test('Claude Code 2.1.325: of names that collide once sanitized, the first listed wins', () => {
    const dottedFirst = renames(['files.read', 'files_read']);
    expect(dottedFirst.get('files.read')).toEqual({
      change: 'sanitized',
      kind: 'renamed',
      rendered: 'files_read',
    });
    expect(dottedFirst.get('files_read')?.kind).toBe('dropped');

    const plainFirst = renames(['files_read', 'files.read']);
    expect(plainFirst.has('files_read')).toBe(false);
    expect(plainFirst.get('files.read')).toEqual({
      kind: 'dropped',
      reason:
        '"files_read", listed before it, also renders as "files_read", and Claude Code keeps only the first',
    });
  });

  test('a repeated name is one tool, not a collision', () => {
    expect([...renames(['files.read', 'plain', 'files.read'])]).toEqual([
      ['files.read', { change: 'sanitized', kind: 'renamed', rendered: 'files_read' }],
    ]);
  });

  test('Claude Code 2.1.325: mcp__target__ plus 115 characters is sent; plus 116 is dropped', () => {
    const fits = 'a'.repeat(115);
    const long = 'b'.repeat(116);
    const result = renames([fits, long]);
    expect(result.has(fits)).toBe(false);
    expect(result.get(long)).toEqual({
      kind: 'dropped',
      reason: `its rendered name "mcp__target__${long}" is 129 characters, and Claude Code sends none longer than 128`,
    });
  });

  test('non-ASCII: each UTF-16 code unit outside [a-zA-Z0-9_-] becomes one underscore', () => {
    for (const name of ['é.x', '😀x']) {
      expect([...renames([name])]).toEqual([
        [name, { change: 'sanitized', kind: 'renamed', rendered: '__x' }],
      ]);
    }
  });

  test('the model costs time linear in a name, whatever its characters', () => {
    // One pass over the name with no regex: no input shape can make it backtrack.
    const shapes: ((size: number) => string)[] = [
      (size) => `${SPECIAL}${'_'.repeat(size - SPECIAL.length - 1)}x`,
      (size) => `${SPECIAL}${'.'.repeat(size - SPECIAL.length)}`,
      (size) => `${'_'.repeat(size - 1)}x`,
      (size) => '😀'.repeat(size / 2),
    ];
    for (const shape of shapes) {
      expectLinearCpuTime(shape, (name) => claudeCodeToolRenames([name]));
    }
  });

  test('the adapter carries the exported model as its rename hook', () => {
    expect(claudeCodeAdapter.toolRenames).toBe(claudeCodeToolRenames);
  });

  test('Claude Code 2.1.325: a name beginning "claude.ai " also collapses underscore runs and trims its edges', () => {
    expect(renames(['claude.ai  x__', 'claude.ai__x__']).get('claude.ai  x__')).toEqual({
      change: 'sanitized',
      kind: 'renamed',
      rendered: 'claude_ai_x',
    });
    // Without the leading "claude.ai " only the plain per-unit rule applies.
    expect(renames(['claude.ai__x__']).get('claude.ai__x__')).toEqual({
      change: 'sanitized',
      kind: 'renamed',
      rendered: 'claude_ai__x__',
    });
  });
});
