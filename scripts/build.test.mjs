/** @file scripts/build.test.mjs Portable clean and build-finalization behavior. */
import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clean, finalize } from './build.mjs';

describe('portable build helper', () => {
  test('clean removes only dist and .tsbuildinfo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crosscheck-build-'));
    try {
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'dist', 'cli.js'), 'generated');
      await writeFile(join(root, '.tsbuildinfo'), 'generated');
      await writeFile(join(root, 'keep.txt'), 'source');

      await clean(root);

      expect(await stat(join(root, 'dist')).catch(() => null)).toBeNull();
      expect(await stat(join(root, '.tsbuildinfo')).catch(() => null)).toBeNull();
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('source');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('finalize makes dist/cli.js executable on POSIX', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crosscheck-build-'));
    try {
      await mkdir(join(root, 'dist'));
      const cli = join(root, 'dist', 'cli.js');
      await writeFile(cli, '#!/usr/bin/env node\n');
      await chmod(cli, 0o644);
      await finalize(root, 'linux');
      expect((await stat(cli)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('finalize is a no-op on Windows', async () => {
    const calls = [];
    await finalize('C:\\repo', 'win32', {
      chmod: (...args) => {
        calls.push(args);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([]);
  });

  test('package scripts use the portable helper for clean and finalize', async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts.clean).toBe('node scripts/build.mjs clean');
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json && node scripts/build.mjs finalize');
    expect(pkg.scripts.rebuild).toBe('bun run clean && bun run build');
    expect(pkg.scripts.prepublishOnly).toBe('bun run rebuild');
  });
});
