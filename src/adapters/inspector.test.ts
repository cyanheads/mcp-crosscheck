/**
 * @file src/adapters/inspector.test.ts
 * Inspector adapter status classification and argv shape, driven through the
 * injectable `Exec` seam: `adapter-broken` (npx could not install or start the
 * client), `capture-failure` (the client exited 0 with output that is not a
 * `tools/list` result), `handshake-failure` (the client ran but could not read
 * the server), and clean captures with their canary round-trips.
 */
import { describe, expect, test } from 'bun:test';
import {
  adapterHarness,
  captureExec,
  NPM_INSTALL_FAILURE,
  recordingExec,
} from '../../tests/helpers/fake-exec.js';
import { createRedactor } from '../redact.js';
import type { AdapterTarget } from '../types.js';
import type { ExecResult } from '../util/exec.js';
import { inspectorAdapter } from './inspector.js';

const { context } = adapterHarness('crosscheck-inspector-');

/** The command line every stdio client receives in the target's place (see src/run.ts). */
const LAUNCHER_TARGET: Extract<AdapterTarget, { kind: 'stdio' }> = {
  args: ['/crosscheck/dist/launch-target.js', '/scratch/target-launch.json'],
  command: process.execPath,
  kind: 'stdio',
};
const CANARY = { args: { message: 'probe' }, tool: 'echo_message' };

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

  test('capture-failure: exit 0 with stdout that is not a tools/list result', async () => {
    for (const stdout of [
      'Debugger listening on ws://127.0.0.1:9229',
      // Parses as JSON, but not as a tools/list result.
      '{"error":"Error envelope returned when the call fails."}',
    ]) {
      const result = await inspectorAdapter.run(context(captureExec({ stdout })));
      expect(result.status).toBe('capture-failure');
      expect(result.statusDetail).toBe(
        `tools/list output did not parse (${Buffer.byteLength(stdout)} bytes)`,
      );
      expect(result.surface).toBeNull();
      expect(result.canary).toBeNull();
    }
  });

  test('capture-failure: a cut tools/list names the capture limit and counts bytes, not characters', async () => {
    // 24 UTF-16 code units, 25 UTF-8 bytes: the count is bytes.
    const stdout = '{"tools":[{"name":"élan"';
    const result = await inspectorAdapter.run(
      context(captureExec({ stdout, stdoutTruncated: true })),
    );
    expect(result.status).toBe('capture-failure');
    expect(result.statusDetail).toBe(
      'tools/list output exceeded the capture limit (25 bytes captured)',
    );
  });

  test('capture-failure carries no payload text, even an error-shaped one', async () => {
    const stdout = JSON.stringify({
      tools: [{ description: 'Error envelope returned when the call fails.' }],
    });
    const result = await inspectorAdapter.run(context(captureExec({ stdout, stderr: '' })));
    expect(result.status).toBe('capture-failure');
    expect(result.statusDetail).not.toContain('Error envelope');
  });

  test('exit 0 with unparseable stdout is a capture-failure even beside an install signature', async () => {
    const result = await inspectorAdapter.run(
      context(captureExec({ stderr: NPM_INSTALL_FAILURE, stdout: 'not json' })),
    );
    expect(result.status).toBe('capture-failure');
  });

  test('adapter-broken: npx is not on PATH, and the detail says what provides it', async () => {
    const result = await inspectorAdapter.run(
      context(
        captureExec({ code: null, spawnErrorCode: 'ENOENT', stderr: 'Error: spawn npx ENOENT' }),
      ),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toBe('npx is not on PATH — it ships with npm, part of Node.js');
    expect(result.surface).toBeNull();
  });

  test('adapter-broken: any other spawn failure keeps the spawn error text', async () => {
    const result = await inspectorAdapter.run(
      context(captureExec({ code: null, spawnErrorCode: 'E2BIG', stderr: 'Error: spawn E2BIG' })),
    );
    expect(result.status).toBe('adapter-broken');
    expect(result.statusDetail).toBe('npx could not start — Error: spawn E2BIG');
  });

  test('a timeout is classified before the install signature its killed client left', async () => {
    const result = await inspectorAdapter.run(
      context(
        captureExec({
          code: null,
          signal: 'SIGKILL',
          stderr: NPM_INSTALL_FAILURE,
          stdout: 'not json',
          timedOut: true,
        }),
        { timeoutMs: 1_500 },
      ),
    );
    expect([result.status, result.statusDetail]).toEqual([
      'handshake-failure',
      'timed out after 1500ms',
    ]);
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

  test('unpinned: latest resolves once and both invocations spawn exactly that release', async () => {
    const calls: string[][] = [];
    const result = await inspectorAdapter.run(
      context(recordingExec(calls, { stdout: '2.15.0\n' }, ...LIST_AND_CALL), {
        canary: CANARY,
        pins: {},
      }),
    );
    expect(result.resolvedVersion).toBe('2.15.0');
    expect(result.canary?.ok).toBe(true);
    expect(calls.map((args) => args.slice(0, 3))).toEqual([
      ['view', '@modelcontextprotocol/inspector', 'version'],
      ['-y', '@modelcontextprotocol/inspector@2.15.0', '--cli'],
      ['-y', '@modelcontextprotocol/inspector@2.15.0', '--cli'],
    ]);
  });

  test('unpinned with a failed lookup: both invocations spawn @latest and the version is unresolved', async () => {
    const calls: string[][] = [];
    const result = await inspectorAdapter.run(
      context(
        recordingExec(calls, { code: 1, stderr: 'npm error code ENOTFOUND' }, ...LIST_AND_CALL),
        { canary: CANARY, pins: {} },
      ),
    );
    expect(result.status).toBe('ok');
    expect(result.resolvedVersion).toBeNull();
    expect(calls.slice(1).map((args) => args[1])).toEqual([
      '@modelcontextprotocol/inspector@latest',
      '@modelcontextprotocol/inspector@latest',
    ]);
  });

  test('pinned: both invocations spawn the pin and no lookup runs', async () => {
    const calls: string[][] = [];
    const result = await inspectorAdapter.run(
      context(recordingExec(calls, ...LIST_AND_CALL), {
        canary: CANARY,
        pins: { inspector: '2.8.0' },
      }),
    );
    expect(result.resolvedVersion).toBe('2.8.0');
    expect(calls.map((args) => args[1])).toEqual([
      '@modelcontextprotocol/inspector@2.8.0',
      '@modelcontextprotocol/inspector@2.8.0',
    ]);
  });

  test('stdio: both invocations carry the launcher command line and nothing else from the target', async () => {
    const calls: string[][] = [];
    await inspectorAdapter.run(
      context(recordingExec(calls, ...LIST_AND_CALL), {
        canary: CANARY,
        target: LAUNCHER_TARGET,
      }),
    );
    const spec = '@modelcontextprotocol/inspector@2.1.0';
    const launcher = [LAUNCHER_TARGET.command, ...LAUNCHER_TARGET.args];
    expect(calls).toEqual([
      ['-y', spec, '--cli', ...launcher, '--method', 'tools/list'],
      [
        '-y',
        spec,
        '--cli',
        ...launcher,
        '--method',
        'tools/call',
        '--tool-name',
        'echo_message',
        '--tool-args-json',
        '{"message":"probe"}',
      ],
    ]);
  });

  test('canary: a cut tools/call output names the capture limit', async () => {
    const stdout = '{"content":[{"text":"élan';
    const result = await inspectorAdapter.run(
      context(
        captureExec({ stdout: JSON.stringify({ tools: [] }) }, { stdout, stdoutTruncated: true }),
        { canary: CANARY },
      ),
    );
    expect(result.status).toBe('ok');
    expect(result.canary).toEqual({
      attempted: true,
      detail: `tools/call output exceeded the capture limit (${Buffer.byteLength(stdout)} bytes captured)`,
      ok: false,
    });
  });

  test('canary: an uncut unparseable tools/call output is counted, not quoted', async () => {
    const result = await inspectorAdapter.run(
      context(captureExec({ stdout: JSON.stringify({ tools: [] }) }, { stdout: 'not json' }), {
        canary: CANARY,
      }),
    );
    expect(result.canary?.detail).toBe('tools/call output did not parse (8 bytes)');
  });

  test('canary: a timeout and a spawn failure are named as such', async () => {
    const list = { stdout: JSON.stringify({ tools: [] }) };
    const cases: [Partial<ExecResult>, string][] = [
      [{ code: null, signal: 'SIGKILL', timedOut: true }, 'timed out after 5000ms'],
      [
        { code: null, spawnErrorCode: 'E2BIG', stderr: 'Error: spawn E2BIG' },
        'npx could not start — Error: spawn E2BIG',
      ],
    ];
    for (const [call, detail] of cases) {
      const result = await inspectorAdapter.run(
        context(captureExec(list, call), { canary: CANARY }),
      );
      expect(result.status).toBe('ok');
      expect(result.canary).toEqual({ attempted: true, detail, ok: false });
    }
  });
});

describe('inspector: header values are redacted before the detail is cut', () => {
  const SECRET = 'tok_9f8e7d6c5b4a39281706';
  const SPACED_SECRET = 'Bearer\tabc  123';
  const redact = createRedactor([SECRET, SPACED_SECRET]);
  /** Text that, after `prefix`, puts SECRET across excerpt's 400-character cut, at 391. */
  const straddling = (prefix = '') => `${'x'.repeat(400 - prefix.length - 10)} ${SECRET} tail`;
  const spaced = `error: upstream rejected Authorization ${SPACED_SECRET}`;
  const list = { stdout: JSON.stringify({ tools: [] }) };

  /** The marker, whole or cut, and no six-character fragment of either value. */
  function expectRedacted(detail: string | null | undefined): void {
    expect(detail).toContain('[REDACTED');
    for (let start = 0; start + 6 <= SECRET.length; start += 1) {
      expect(detail).not.toContain(SECRET.slice(start, start + 6));
    }
    expect(detail).not.toContain('abc');
  }

  test('a non-zero tools/list exit', async () => {
    for (const stderr of [straddling(), spaced]) {
      const result = await inspectorAdapter.run(
        context(captureExec({ code: 1, stderr }), { redact }),
      );
      expectRedacted(result.statusDetail);
    }
  });

  test('a spawn failure', async () => {
    for (const stderr of [straddling('npx could not start — '), spaced]) {
      const result = await inspectorAdapter.run(
        context(captureExec({ code: null, spawnErrorCode: 'E2BIG', stderr }), { redact }),
      );
      expectRedacted(result.statusDetail);
    }
  });

  test('a non-zero canary exit', async () => {
    for (const stderr of [straddling(), spaced]) {
      const result = await inspectorAdapter.run(
        context(captureExec(list, { code: 1, stderr }), { canary: CANARY, redact }),
      );
      expectRedacted(result.canary?.detail);
    }
  });

  test('a canary the server rejected', async () => {
    for (const text of [straddling('server rejected the call — '), spaced]) {
      const rejected = {
        stdout: JSON.stringify({ content: [{ text, type: 'text' }], isError: true }),
      };
      const result = await inspectorAdapter.run(
        context(captureExec(list, rejected), { canary: CANARY, redact }),
      );
      expectRedacted(result.canary?.detail);
    }
  });
});
