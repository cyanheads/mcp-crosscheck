/**
 * @file src/util/versions.ts
 * Registry lookups for an unpinned adapter's latest release. Latest floats by
 * design, so an unpinned run asks the registry once, spawns exactly the
 * release it names on every invocation, and reports it: a bare package name
 * could run a locally installed copy of another version instead. Lookups are
 * bounded and best-effort; null means unresolved, and the run spawns
 * `@latest` and reports no version.
 */
import { z } from 'zod';

import type { Exec } from './exec.js';

/** Latest published version of an npm package, via `npm view`. */
export async function npmLatestVersion(
  pkg: string,
  workDir: string,
  exec: Exec,
): Promise<string | null> {
  const result = await exec.capture('npm', ['view', pkg, 'version'], {
    cwd: workDir,
    timeoutMs: 15_000,
  });
  const match = result.stdout.trim().match(/\d+\.\d+\.\d+\S*/);
  return match?.[0] ?? null;
}

/** The part of PyPI's project JSON this reads: `info.version` is the latest release. */
const PypiProject = z.object({ info: z.object({ version: z.string().min(1) }) });

/**
 * Latest release of a PyPI package, from its JSON API, or null when the
 * lookup fails or the body is not that shape. A live `fetch` outside the Exec
 * seam: a test that runs an unpinned mcpo stubs `fetch`.
 */
export async function pypiLatestVersion(pkg: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const response = await fetch(`https://pypi.org/pypi/${pkg}/json`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const parsed = PypiProject.safeParse(await response.json());
    return parsed.success ? parsed.data.info.version : null;
  } catch {
    return null;
  }
}
