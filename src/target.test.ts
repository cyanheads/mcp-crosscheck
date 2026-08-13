/**
 * @file src/target.test.ts
 * Lexical target canonicalization at the orchestration boundary.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { canonicalizeTarget } from './target.js';
import type { TargetSpec } from './types.js';

const CWD = resolve('workspace', 'project');

describe('canonicalizeTarget', () => {
  test('resolves explicit-relative command and argument tokens against the injected cwd', () => {
    const env = { FIXTURE_MODE: 'stdio' };
    const target: TargetSpec = {
      args: ['./server.js', '../shared/config.json'],
      command: './bin/runner',
      env,
      kind: 'stdio',
    };

    const canonical = canonicalizeTarget(target, CWD);

    expect(canonical).toEqual({
      args: [resolve(CWD, './server.js'), resolve(CWD, '../shared/config.json')],
      command: resolve(CWD, './bin/runner'),
      env,
      kind: 'stdio',
    });
    expect(canonical.kind === 'stdio' && canonical.env).toBe(env);
  });

  test('leaves absolute, bare, URL, option, and non-prefix relative tokens unchanged', () => {
    const absolute = resolve(CWD, 'server.js');
    const args = [
      absolute,
      'server.js',
      'https://example.com/relative.js',
      'file:///tmp/server.js',
      '--config',
      '--config=./server.json',
      '.',
      '..',
    ];
    const target: TargetSpec = { args, command: 'node', env: {}, kind: 'stdio' };

    expect(canonicalizeTarget(target, CWD)).toEqual(target);
  });

  test('canonicalizes a missing explicit-relative path without preflighting it', () => {
    const target: TargetSpec = {
      args: ['./missing-server.js'],
      command: 'node',
      env: {},
      kind: 'stdio',
    };

    expect(canonicalizeTarget(target, CWD)).toEqual({
      args: [resolve(CWD, './missing-server.js')],
      command: 'node',
      env: {},
      kind: 'stdio',
    });
  });

  test('leaves HTTP targets unchanged', () => {
    const target: TargetSpec = { kind: 'http', url: 'https://example.com/mcp' };

    expect(canonicalizeTarget(target, CWD)).toBe(target);
  });
});
