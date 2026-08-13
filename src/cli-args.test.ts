/** @file src/cli-args.test.ts Focused parsing for repeatable HTTP target headers. */
import { expect, test } from 'bun:test';

import { parseHttpHeaders, validateHttpHeaders } from './cli-args.js';

test('splits the first colon and trims repeated header names and values', () => {
  expect(
    parseHttpHeaders(['  X-Callback : https://example.test:8443/path  ', 'X-Mode: demo']),
  ).toEqual({ 'X-Callback': 'https://example.test:8443/path', 'X-Mode': 'demo' });
});

test('rejects malformed and case-insensitive duplicate names without echoing values', () => {
  const secret = 'fixture-secret';
  for (const entries of [
    [`Bad Name: ${secret}`],
    [`X-Test: ${secret}`, 'x-test: duplicate'],
    [`NoColon${secret}`],
    [`: ${secret}`],
    ['X-Empty:   '],
    [`X-Newline: ${secret}\r\ninjected: yes`],
  ]) {
    try {
      parseHttpHeaders(entries);
      throw new Error('expected parsing to fail');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  }
});

test('validates programmatic maps with the same rules and safe plain-object construction', () => {
  const headers = validateHttpHeaders(
    Object.fromEntries([
      ['__proto__', 'safe'],
      ['X-Mode', 'demo'],
    ]),
  );
  expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
  expect(Object.hasOwn(headers, '__proto__')).toBe(true);
  expect(Object.entries(headers)).toEqual([
    ['__proto__', 'safe'],
    ['X-Mode', 'demo'],
  ]);
});
