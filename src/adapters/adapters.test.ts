/**
 * @file src/adapters/adapters.test.ts
 * Fixture-driven tests for the adapter surface parsers, using real captures
 * from live runs against mcp-ts-core's examples server (2026-08-09): a Codex
 * CLI 0.147.0 intercepted request body and an mcpo 0.0.20 openapi.json. These
 * lock the live-verified parsing behavior as regression tests.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareSurface } from '../invariants.js';
import type { GroundTruth } from '../types.js';
import { surfaceFromCodexBody } from './codex.js';
import { surfaceFromOpenApiDoc } from './mcpo.js';

const FIXTURES = join(import.meta.dir, '..', '..', 'tests', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

const groundTruth = loadFixture('ground-truth.json') as GroundTruth;
const EXAMPLE_TOOLS = [
  'template_async_countdown',
  'template_cat_fact',
  'template_data_explorer',
  'template_echo_message',
  'template_image_test',
  'template_madlibs_elicitation',
];

describe('surfaceFromCodexBody', () => {
  const surface = surfaceFromCodexBody(loadFixture('codex-request.json'));

  test('unwraps the mcp__ namespace and excludes codex-native tools', () => {
    expect(surface).not.toBeNull();
    expect(surface?.tools.map((tool) => tool.name).sort()).toEqual(EXAMPLE_TOOLS);
  });

  test('keeps types, descriptions, and enum; codex strips minimum/maximum', () => {
    const echo = surface?.tools.find((tool) => tool.name === 'template_echo_message');
    const message = echo?.properties.find((property) => property.name === 'message');
    const mode = echo?.properties.find((property) => property.name === 'mode');
    expect(message?.type).toBe('string');
    expect(message?.description).not.toBeNull();
    expect(mode?.constraints.enum).toBeDefined();

    const catFact = surface?.tools.find((tool) => tool.name === 'template_cat_fact');
    const maxLength = catFact?.properties.find((property) => property.name === 'maxLength');
    expect(maxLength?.constraints.minimum).toBeUndefined();
    expect(maxLength?.constraints.maximum).toBeUndefined();
  });

  test('diff against ground truth yields info-only findings', () => {
    const findings = compareSurface(groundTruth.tools, surface ?? { tools: [] });
    expect(findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
    expect(findings.every((finding) => finding.rule === 'constraint-dropped')).toBe(true);
  });

  test('parses the older flat mcp__target__ function form', () => {
    const flat = {
      tools: [
        {
          name: 'mcp__target__echo',
          parameters: { properties: { m: { type: 'string' } }, type: 'object' },
          type: 'function',
        },
      ],
    };
    const parsed = surfaceFromCodexBody(flat);
    expect(parsed?.tools[0]?.name).toBe('echo');
  });

  test('returns null for bodies without MCP tools', () => {
    expect(
      surfaceFromCodexBody({ tools: [{ name: 'exec_command', type: 'function' }] }),
    ).toBeNull();
    expect(surfaceFromCodexBody({})).toBeNull();
    expect(surfaceFromCodexBody('nope')).toBeNull();
  });
});

describe('surfaceFromOpenApiDoc', () => {
  const surface = surfaceFromOpenApiDoc(loadFixture('mcpo-openapi.json'));

  test('maps every post route to a tool', () => {
    expect(surface).not.toBeNull();
    expect(surface?.tools.map((tool) => tool.name).sort()).toEqual(EXAMPLE_TOOLS);
  });

  test('resolves form-model $refs into typed, described properties', () => {
    const echo = surface?.tools.find((tool) => tool.name === 'template_echo_message');
    expect(echo?.description).not.toBeNull();
    const message = echo?.properties.find((property) => property.name === 'message');
    expect(message?.type).toBe('string');
    expect(message?.description).not.toBeNull();
    expect(echo?.requiredNames).toContain('message');
  });

  test('mcpo strips enum and numeric bounds (recorded as info by the engine)', () => {
    const echo = surface?.tools.find((tool) => tool.name === 'template_echo_message');
    const mode = echo?.properties.find((property) => property.name === 'mode');
    expect(mode?.constraints.enum).toBeUndefined();

    const findings = compareSurface(groundTruth.tools, surface ?? { tools: [] });
    expect(findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
    expect(findings.some((finding) => finding.detail.includes('enum'))).toBe(true);
  });

  test('a null requestBody renders as an empty surface the engine can flag', () => {
    const doc = {
      paths: { '/broken_tool': { post: { description: 'Broken.', requestBody: null } } },
    };
    const parsed = surfaceFromOpenApiDoc(doc);
    expect(parsed?.tools[0]?.properties).toEqual([]);
  });

  test('returns null for non-OpenAPI documents', () => {
    expect(surfaceFromOpenApiDoc({ nope: true })).toBeNull();
    expect(surfaceFromOpenApiDoc(null)).toBeNull();
  });
});
