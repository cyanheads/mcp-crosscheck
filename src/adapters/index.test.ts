/**
 * @file src/adapters/index.test.ts
 * The adapter registry: which adapters exist, which run by default, and the
 * name guard that keeps prototype keys out of adapter lookup.
 */
import { describe, expect, test } from 'bun:test';
import { ADAPTERS, DEFAULT_ADAPTERS, isAdapterName } from './index.js';

test('claude-code is registered as opt-in without changing hermetic defaults', () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual(['claude-code', 'codex', 'inspector', 'mcpo']);
  expect(ADAPTERS['claude-code'].optIn).toBe(true);
  expect(DEFAULT_ADAPTERS).toEqual(['inspector', 'mcpo']);
});

describe('isAdapterName', () => {
  test('accepts exactly the four registered adapter names', () => {
    for (const name of ['claude-code', 'codex', 'inspector', 'mcpo']) {
      expect(isAdapterName(name)).toBe(true);
    }
  });

  test('rejects every inherited Object.prototype key and unknown names', () => {
    const inherited = Object.getOwnPropertyNames(Object.prototype);
    expect(inherited).toContain('__proto__');
    expect(inherited).toContain('constructor');
    expect([...inherited, 'nope', ''].filter((name) => isAdapterName(name))).toEqual([]);
  });
});
