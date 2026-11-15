/**
 * @file src/target.test.ts
 * The canonical target launch: the environment, working directory, and command
 * line ground truth and the client launcher share.
 */
import { describe, expect, test } from 'bun:test';

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

import { TargetLaunchSchema, targetEnvironment, targetLaunch } from './target.js';
import type { TargetSpec } from './types.js';

describe('targetEnvironment', () => {
  test('is the SDK default environment plus the given values, which win', () => {
    const defaults = getDefaultEnvironment();
    expect(Object.keys(defaults)).toContain('PATH');
    expect(targetEnvironment({})).toEqual(defaults);
    expect(targetEnvironment({ HOME: '/elsewhere', MY_FLAG: '' })).toEqual({
      ...defaults,
      HOME: '/elsewhere',
      MY_FLAG: '',
    });
  });

  test('leaves out a variable this process has that is neither a default nor given', () => {
    process.env.CROSSCHECK_TARGET_TEST_ONLY = 'exported';
    try {
      expect(Object.keys(targetEnvironment({}))).not.toContain('CROSSCHECK_TARGET_TEST_ONLY');
    } finally {
      delete process.env.CROSSCHECK_TARGET_TEST_ONLY;
    }
  });
});

describe('targetLaunch', () => {
  test('keeps the command line as given and runs it in this process directory', () => {
    const target: TargetSpec = {
      args: ['./server.js', '../shared/config.json', 'bare/relative.js', '--flag', 'x', '-e', 'y'],
      command: './bin/runner',
      env: { MCP_MODE: 'probe' },
      kind: 'stdio',
    };
    expect(targetLaunch(target)).toEqual({
      args: ['./server.js', '../shared/config.json', 'bare/relative.js', '--flag', 'x', '-e', 'y'],
      command: './bin/runner',
      cwd: process.cwd(),
      env: { ...getDefaultEnvironment(), MCP_MODE: 'probe' },
    });
  });

  test('round-trips through its spec file format', () => {
    const launch = targetLaunch({ args: ['a b', ''], command: 'node', env: {}, kind: 'stdio' });
    expect(TargetLaunchSchema.parse(JSON.parse(JSON.stringify(launch)))).toEqual(launch);
  });

  test('the spec file format rejects a missing field, a wrong type, and an unknown key', () => {
    const launch = { args: [], command: 'node', cwd: '/', env: {} };
    for (const spec of [
      { args: [], command: 'node', env: {} },
      { ...launch, args: 'server.js' },
      { ...launch, env: { PORT: 8080 } },
      { ...launch, shell: true },
    ]) {
      expect(TargetLaunchSchema.safeParse(spec).success).toBe(false);
    }
  });
});
