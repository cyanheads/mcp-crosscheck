/**
 * @file scripts/devcheck.ts
 * Local CI gate — run before every commit. Sequential steps, loud output,
 * non-zero exit on any failure. Warnings are failures: the Biome step runs
 * with --error-on-warnings, so a green run means zero diagnostics.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface Step {
  name: string;
  run: () => { detail?: string; ok: boolean };
}

function shell(command: string, args: string[]): { ok: boolean } {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return { ok: result.status === 0 };
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const steps: Step[] = [
  {
    name: 'Biome (format + lint, zero warnings)',
    run: () => shell('bunx', ['biome', 'check', '--write', '--error-on-warnings', '.']),
  },
  {
    name: 'Typecheck (tsc --noEmit)',
    run: () => shell('bunx', ['tsc', '--noEmit']),
  },
  {
    name: 'Build (tsc → dist)',
    run: () => shell('bun', ['run', 'build']),
  },
  {
    name: 'Tests (bun test)',
    run: () => shell('bun', ['test']),
  },
  {
    name: 'Changelog carries the current version',
    run: () => {
      try {
        const changelog = readFileSync('CHANGELOG.md', 'utf8');
        return changelog.includes(`## ${pkg.version}`)
          ? { ok: true }
          : { detail: `CHANGELOG.md has no "## ${pkg.version}" heading`, ok: false };
      } catch {
        return { detail: 'CHANGELOG.md is missing', ok: false };
      }
    },
  },
  {
    name: 'CLI bin is intact',
    run: () => {
      try {
        const cli = readFileSync('dist/cli.js', 'utf8');
        return cli.startsWith('#!/usr/bin/env node')
          ? { ok: true }
          : { detail: 'dist/cli.js lost its shebang', ok: false };
      } catch {
        return { detail: 'dist/cli.js is missing — build failed?', ok: false };
      }
    },
  },
];

let failed = 0;
for (const step of steps) {
  console.log(`\n━━━ ${step.name} ━━━`);
  const result = step.run();
  if (result.ok) {
    console.log(`✅ PASSED: ${step.name}`);
  } else {
    failed += 1;
    console.log(
      `❌ FAILED: ${step.name}${result.detail === undefined ? '' : ` — ${result.detail}`}`,
    );
  }
}

console.log(
  failed === 0
    ? `\n✅ devcheck: all ${steps.length} steps passed (v${pkg.version})`
    : `\n❌ devcheck: ${failed}/${steps.length} step(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);
