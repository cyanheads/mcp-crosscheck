/**
 * @file scripts/build.mjs
 * Node-core generated-output cleanup and executable-bit finalization.
 */
import { chmod, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Remove only the TypeScript outputs owned by the build. */
export async function clean(root = PROJECT_ROOT, operations = { rm }) {
  await Promise.all([
    operations.rm(join(root, 'dist'), { force: true, recursive: true }),
    operations.rm(join(root, '.tsbuildinfo'), { force: true }),
  ]);
}

/** Mark the built CLI executable where POSIX mode bits exist. */
export async function finalize(
  root = PROJECT_ROOT,
  platform = process.platform,
  operations = { chmod },
) {
  if (platform === 'win32') return;
  await operations.chmod(join(root, 'dist', 'cli.js'), 0o755);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const operation = process.argv[2];
  if (operation === 'clean') {
    await clean();
  } else if (operation === 'finalize') {
    await finalize();
  } else {
    throw new Error('usage: node scripts/build.mjs <clean|finalize>');
  }
}
