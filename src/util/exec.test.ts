/**
 * @file src/util/exec.test.ts
 * Tests for the process helpers: output compression (findings and status
 * details must stay one bounded line, whatever a child prints) and the timeout
 * path that feeds `handshake-failure` classification.
 */
import { describe, expect, test } from 'bun:test';

import { excerpt, execCapture, nodeExec } from './exec.js';

/** The shape mcpo fails with when a fresh `uvx` resolve pulls an incompatible dependency. */
const PYTHON_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/Users/x/.cache/uv/environments-v2/mcpo/bin/mcpo", line 5, in <module>',
  '    from mcpo.main import app',
  '  File "/Users/x/.cache/uv/environments-v2/mcpo/lib/python3.13/site-packages/mcpo/main.py", line 9',
  '    from mcp.client.streamable_http import streamablehttp_client',
  'ImportError: cannot import name streamablehttp_client',
].join('\n');

const RICH_TRACEBACK = [
  'Resolving packages '.repeat(16),
  '╭──────────────────── Traceback (most recent call last) ────────────────────╮',
  '│ /tmp/mcpo/bin/mcpo:5 in <module>                                         │',
  '│                                                                          │',
  '│   from mcpo.main import app                                              │',
  '╰──────────────────────────────────────────────────────────────────────────╯',
  'ImportError: cannot import name streamablehttp_client',
].join('\n');

describe('excerpt', () => {
  test('flattens a multi-line traceback into one line', () => {
    const line = excerpt(PYTHON_TRACEBACK);
    expect(line).not.toContain('\n');
    expect(line).toContain('Traceback (most recent call last):');
    expect(line).toContain('ImportError: cannot import name streamablehttp_client');
  });

  test('anchors an overflowing boxed traceback at its terminal error', () => {
    const line = excerpt(RICH_TRACEBACK, 150);
    expect(line).not.toContain('\n');
    expect(line.startsWith('…')).toBe(true);
    expect(line).toContain('from mcpo.main import app');
    expect(line).toContain('ImportError: cannot import name streamablehttp_client');
    expect(line.length).toBeLessThanOrEqual(151);
  });

  test('collapses whitespace runs and trims the edges', () => {
    expect(excerpt('  spread   \n\t over  lines \n')).toBe('spread over lines');
  });

  test('removes blank and decoration-only box-drawing lines', () => {
    expect(excerpt(' before \n\n  ├─────┤  \n\t after ')).toBe('before after');
  });

  test('returns an empty excerpt when normalization removes every line', () => {
    expect(excerpt('\n ───── \n\t')).toBe('');
  });

  test('does not add an ellipsis when normalized content exactly meets the budget', () => {
    expect(excerpt('12345', 5)).toBe('12345');
  });

  test('keeps the existing head selection when no error-shaped line is present', () => {
    expect(excerpt('package runner preamble\nstill resolving dependencies', 24)).toBe(
      'package runner preamble …',
    );
  });

  test('does not promote warnings to error-tail selection', () => {
    expect(
      excerpt(`npm WARN failed optional dependency\n${'ordinary chatter '.repeat(8)}`, 32),
    ).toBe('npm WARN failed optional depende…');
  });

  test('recognizes each canonical error-shaped form case-insensitively', () => {
    for (const errorLine of [
      'error: terminal',
      'EXCEPTION: terminal',
      'Traceback: terminal',
      'ImportError: terminal',
      'ModuleNotFoundError: terminal',
      'Cannot load terminal',
      'FAILED to load terminal',
      'npm ERR! code E404 terminal',
    ]) {
      const line = excerpt(`${'install chatter '.repeat(8)}\n${errorLine}`, 32);
      expect(line.startsWith('…')).toBe(true);
      expect(line.endsWith(errorLine)).toBe(true);
      expect(line.length).toBeLessThanOrEqual(33);
    }
  });

  test('anchors at the last error-shaped source line', () => {
    const line = excerpt(
      `Error: first failure\n${'intervening context '.repeat(5)}\nFailed: terminal failure`,
      40,
    );
    expect(line).toBe('…rvening context Failed: terminal failure');
  });

  test('keeps the end of an error line longer than the content budget', () => {
    const line = excerpt(`Error: ${'x'.repeat(80)}terminal`, 24);
    expect(line).toBe(`…${'x'.repeat(16)}terminal`);
    expect(line.length).toBe(25);
  });

  test('uses a suffix marker when only output after the error is omitted', () => {
    expect(excerpt(`Error: terminal\n${'footer '.repeat(20)}`, 24)).toBe('Error: terminal…');
  });

  test('marks both omitted sides without losing the error behind a long footer', () => {
    const line = excerpt(
      `${'install chatter '.repeat(10)}\nError: terminal failure\n${'footer noise '.repeat(20)}`,
      24,
    );
    expect(line).toBe('…Error: terminal failure…');
    expect(line.length).toBe(25);
  });

  test('uses one marker for a zero content budget and rejects invalid budgets', () => {
    expect(excerpt('omitted', 0)).toBe('…');
    expect(() => excerpt('invalid', -1)).toThrow(RangeError);
    expect(() => excerpt('invalid', 1.5)).toThrow(RangeError);
  });
});

describe('execCapture', () => {
  test('inherits the parent environment by default and supports an explicit clean one', async () => {
    const printPath = 'console.log(JSON.stringify({ PATH: process.env.PATH }))';
    const inherited = await execCapture(process.execPath, ['-e', printPath], {
      timeoutMs: 30_000,
    });
    expect(JSON.parse(inherited.stdout)).toEqual({ PATH: process.env.PATH });

    const clean = await execCapture(process.execPath, ['-e', printPath], {
      inheritEnv: false,
      timeoutMs: 30_000,
    });
    expect(JSON.parse(clean.stdout)).toEqual({});

    const managed = nodeExec.spawn(process.execPath, ['-e', printPath], {
      inheritEnv: false,
    });
    await managed.exited;
    expect(JSON.parse(managed.stdoutTail())).toEqual({});
  });

  test('captures stdout and the exit code', async () => {
    const result = await execCapture(process.execPath, ['-e', 'console.log("captured")'], {
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('captured');
    expect(result.timedOut).toBe(false);
  });

  test('kills a child that overruns its budget and reports timedOut', async () => {
    const result = await execCapture(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      timeoutMs: 250,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });
});
