/**
 * @file src/version.ts
 * Resolves the package version at runtime from package.json, so the CLI,
 * the ground-truth client identity, and reports all agree on one value.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/** The published mcp-crosscheck version. */
export const VERSION: string = pkg.version;
