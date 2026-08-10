/**
 * @file src/util/versions.ts
 * Resolved-version reporting. Latest floats by design, so every run records
 * what it actually exercised: pins short-circuit, registry lookups are
 * best-effort and bounded, and null degrades to "version unresolved".
 */
import { execCapture } from './exec.js';

/** Latest published version of an npm package, via `npm view`. */
export async function npmLatestVersion(pkg: string, workDir: string): Promise<string | null> {
  const result = await execCapture('npm', ['view', pkg, 'version'], {
    cwd: workDir,
    timeoutMs: 15_000,
  });
  const match = result.stdout.trim().match(/\d+\.\d+\.\d+\S*/);
  return match?.[0] ?? null;
}

/** Latest published version of a PyPI package, via the JSON API. */
export async function pypiLatestVersion(pkg: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const response = await fetch(`https://pypi.org/pypi/${pkg}/json`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('info' in body)) return null;
    const { info } = body as { info: unknown };
    if (typeof info !== 'object' || info === null || !('version' in info)) return null;
    const { version } = info as { version: unknown };
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}
