/**
 * @file tests/helpers/captured-fixtures.ts
 * Loader for the frozen live captures under `tests/fixtures/`, plus the ground
 * truth the Codex and mcpo captures were taken against (`example-mcp-server`
 * and its six `template_*` tools). The Claude Code capture renders the bundled
 * fixture server instead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GroundTruth } from '../../src/types.js';

const FIXTURES = join(import.meta.dir, '..', 'fixtures');

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

export const exampleGroundTruth = loadFixture('ground-truth.json') as GroundTruth;

/** The example server's tool names, sorted. */
export const EXAMPLE_TOOLS = [
  'template_async_countdown',
  'template_cat_fact',
  'template_data_explorer',
  'template_echo_message',
  'template_image_test',
  'template_madlibs_elicitation',
];
