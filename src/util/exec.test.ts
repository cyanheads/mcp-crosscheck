/**
 * @file src/util/exec.test.ts
 * Tests for the process helpers: output compression (findings and status
 * details must stay one bounded line, whatever a child prints) and the timeout
 * path that feeds `handshake-failure` classification.
 */
import { describe, expect, test } from 'bun:test';

import { excerpt, execCapture } from './exec.js';

/** The shape mcpo fails with when a fresh `uvx` resolve pulls an incompatible dependency. */
const PYTHON_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/Users/x/.cache/uv/environments-v2/mcpo/bin/mcpo", line 5, in <module>',
  '    from mcpo.main import app',
  '  File "/Users/x/.cache/uv/environments-v2/mcpo/lib/python3.13/site-packages/mcpo/main.py", line 9',
  '    from mcp.client.streamable_http import streamablehttp_client',
  'ImportError: cannot import name streamablehttp_client',
].join('\n');

describe('excerpt', () => {
  test('flattens a multi-line traceback into one line', () => {
    const line = excerpt(PYTHON_TRACEBACK);
    expect(line).not.toContain('\n');
    expect(line).toContain('Traceback (most recent call last):');
    expect(line).toContain('ImportError: cannot import name streamablehttp_client');
  });

  test('bounds output at the maximum length', () => {
    const line = excerpt(PYTHON_TRACEBACK, 80);
    expect(line).not.toContain('\n');
    expect(line.length).toBe(81); // 80 characters plus the ellipsis
    expect(line.endsWith('…')).toBe(true);
  });

  test('collapses whitespace runs and trims the edges', () => {
    expect(excerpt('  spread   \n\t over  lines \n')).toBe('spread over lines');
  });
});

describe('execCapture', () => {
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
