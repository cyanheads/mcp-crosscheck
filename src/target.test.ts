/**
 * @file src/target.test.ts
 * Lexical target canonicalization at the orchestration boundary.
 */
import { describe, expect, test } from 'bun:test';
import { posix, resolve, win32 } from 'node:path';

import { canonicalizeTarget } from './target.js';
import type { TargetSpec } from './types.js';

const CWD = resolve('workspace', 'project');

function stdioTarget(token: string): TargetSpec {
  return { args: [token], command: token, env: {}, kind: 'stdio' };
}

describe('canonicalizeTarget', () => {
  test('resolves explicit-relative command and argument tokens against the injected cwd', () => {
    const env = { FIXTURE_MODE: 'stdio' };
    const target: TargetSpec = {
      args: ['./server.js', '../shared/config.json'],
      command: './bin/runner',
      env,
      kind: 'stdio',
    };

    const canonical = canonicalizeTarget(target, CWD, process.platform);

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

    expect(canonicalizeTarget(target, CWD, process.platform)).toEqual(target);
  });

  test('canonicalizes a missing explicit-relative path without preflighting it', () => {
    const target: TargetSpec = {
      args: ['./missing-server.js'],
      command: 'node',
      env: {},
      kind: 'stdio',
    };

    expect(canonicalizeTarget(target, CWD, process.platform)).toEqual({
      args: [resolve(CWD, './missing-server.js')],
      command: 'node',
      env: {},
      kind: 'stdio',
    });
  });

  test('leaves HTTP targets unchanged', () => {
    const target: TargetSpec = { kind: 'http', url: 'https://example.com/mcp' };

    expect(canonicalizeTarget(target, CWD, process.platform)).toBe(target);
  });
});

describe('canonicalizeTarget platform spellings', () => {
  test('win32 resolves backslash and slash explicit-relative tokens with win32 semantics', () => {
    const cwd = 'C:\\proj';
    for (const token of ['.\\x', '..\\x', './x', '../x']) {
      const expected = win32.resolve(cwd, token);
      expect(canonicalizeTarget(stdioTarget(token), cwd, 'win32')).toEqual({
        args: [expected],
        command: expected,
        env: {},
        kind: 'stdio',
      });
    }
    expect(canonicalizeTarget(stdioTarget('.\\dist\\index.js'), cwd, 'win32')).toMatchObject({
      args: ['C:\\proj\\dist\\index.js'],
    });
    expect(canonicalizeTarget(stdioTarget('..\\shared\\server.js'), cwd, 'win32')).toMatchObject({
      args: ['C:\\shared\\server.js'],
    });
  });

  test('win32 leaves bare, absolute, dot-only, and non-prefix tokens unchanged', () => {
    for (const token of ['server.js', 'C:\\abs\\server.js', '.', '..', '...\\x', '.hidden\\x']) {
      expect(canonicalizeTarget(stdioTarget(token), 'C:\\proj', 'win32')).toEqual(
        stdioTarget(token),
      );
    }
  });

  test('POSIX resolves slash spellings only; a backslash prefix is a legal filename', () => {
    const cwd = '/proj';
    for (const platform of ['linux', 'darwin'] as const) {
      expect(canonicalizeTarget(stdioTarget('./x'), cwd, platform)).toMatchObject({
        args: [posix.resolve(cwd, './x')],
      });
      expect(canonicalizeTarget(stdioTarget('../x'), cwd, platform)).toMatchObject({
        args: [posix.resolve(cwd, '../x')],
      });
      expect(canonicalizeTarget(stdioTarget('.\\x'), cwd, platform)).toEqual(stdioTarget('.\\x'));
      expect(canonicalizeTarget(stdioTarget('..\\x'), cwd, platform)).toEqual(stdioTarget('..\\x'));
    }
  });
});
