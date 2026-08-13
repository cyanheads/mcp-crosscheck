/**
 * @file src/adapters/adapters.test.ts
 * Fixture-driven tests for the adapter surface parsers, using real captures
 * from live runs: a Codex CLI 0.147.0 intercepted request body and mcpo 0.0.20
 * openapi.json from 2026-08-09, plus a Claude Code 2.1.231 request from
 * 2026-08-13. These lock the live-verified parsing behavior as regressions.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_TOOLS } from '../../tests/fixture-server/tools.js';
import { compareSurface } from '../invariants.js';
import type { GroundTruth, GroundTruthTool } from '../types.js';
import { surfaceFromClaudeCodeBody } from './claude-code.js';
import { surfaceFromCodexBody } from './codex.js';
import { ADAPTERS, DEFAULT_ADAPTERS } from './index.js';
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
const FIXTURE_TOOL_NAMES = FIXTURE_TOOLS.map((tool) => tool.name).sort();
const FIXTURE_GROUND_TRUTH: GroundTruthTool[] = FIXTURE_TOOLS.map((tool) => ({
  description: tool.description ?? null,
  inputSchema: tool.inputSchema,
  name: tool.name,
  ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
}));

test('claude-code is registered as opt-in without changing hermetic defaults', () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual(['claude-code', 'codex', 'inspector', 'mcpo']);
  expect(ADAPTERS['claude-code'].optIn).toBe(true);
  expect(DEFAULT_ADAPTERS).toEqual(['inspector', 'mcpo']);
});

describe('surfaceFromClaudeCodeBody', () => {
  const fixture = loadFixture('claude-code-request.json');
  const surface = surfaceFromClaudeCodeBody(fixture, 'fixture');

  test('retains only tools while exercising native-tool filtering', () => {
    expect(Object.keys(fixture as Record<string, unknown>)).toEqual(['tools']);
    expect((fixture as { tools: unknown[] }).tools).toHaveLength(9);
    expect(surface?.tools.map((tool) => tool.name).sort()).toEqual(FIXTURE_TOOL_NAMES);
  });

  test('normalizes descriptions, nested input schemas, and constraints', () => {
    const nested = surface?.tools.find((tool) => tool.name === 'nested_config');
    const config = nested?.properties.find((property) => property.name === 'config');
    const transport = config?.children?.find((property) => property.name === 'transport');
    const timeout = transport?.children?.find((property) => property.name === 'timeoutMs');
    expect(nested?.description).not.toBeNull();
    expect(config?.required).toBe(true);
    expect(transport?.requiredNames).toEqual(['timeoutMs']);
    expect(timeout?.type).toBe('integer');
    expect(timeout?.constraints.minimum).toBe(1);
  });

  test('records only the observed root-union flattening', () => {
    const findings = compareSurface(FIXTURE_GROUND_TRUTH, surface ?? { tools: [] });
    expect(findings).toEqual([
      expect.objectContaining({ path: 'union_modes', rule: 'anyof-ignored', severity: 'info' }),
      expect.objectContaining({
        path: 'branch_only_fields',
        rule: 'anyof-ignored',
        severity: 'info',
      }),
    ]);
  });

  test('exposes no rendered output surface', () => {
    expect(surface?.tools.every((tool) => tool.outputProperties === undefined)).toBe(true);
  });

  test('returns null without exact mcp__target__ tool entries', () => {
    expect(surfaceFromClaudeCodeBody({ tools: [{ name: 'Bash', input_schema: {} }] })).toBeNull();
    expect(
      surfaceFromClaudeCodeBody({
        tools: [{ name: 'mcp__other__echo', input_schema: { type: 'object' } }],
      }),
    ).toBeNull();
    expect(surfaceFromClaudeCodeBody({})).toBeNull();
  });
});

describe('surfaceFromCodexBody', () => {
  const fixture = loadFixture('codex-request.json');
  const surface = surfaceFromCodexBody(fixture);

  test('the frozen request fixture retains only its parser-relevant tools payload', () => {
    expect(Object.keys(fixture as Record<string, unknown>)).toEqual(['tools']);
  });

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

  test('codex renders no output surface — its tool entries carry input parameters only', () => {
    expect(surface?.tools.every((tool) => tool.outputProperties === undefined)).toBe(true);
    const findings = compareSurface(groundTruth.tools, surface ?? { tools: [] });
    expect(findings.some((finding) => finding.rule === 'output-schema-divergence')).toBe(false);
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

  test('the anyOf response envelope becomes the rendered result model', () => {
    // mcpo wraps the generated model in `{anyOf: [{$ref: ...}, {}]}`; the union
    // branch is where every output field lives.
    const explorer = surface?.tools.find((tool) => tool.name === 'template_data_explorer');
    expect(explorer?.outputProperties?.map((property) => property.name)).toEqual([
      'rows',
      'generatedAt',
      'summary',
    ]);
    const generatedAt = explorer?.outputProperties?.find(
      (property) => property.name === 'generatedAt',
    );
    expect(generatedAt?.type).toBe('string');
    expect(generatedAt?.description).not.toBeNull();
  });

  test('response models nest through rows.items and summary', () => {
    const explorer = surface?.tools.find((tool) => tool.name === 'template_data_explorer');
    const rows = explorer?.outputProperties?.find((property) => property.name === 'rows');
    expect(rows?.type).toBe('array');
    expect(rows?.items?.children?.map((child) => child.name)).toEqual([
      'id',
      'region',
      'product',
      'units',
      'revenue',
      'date',
    ]);
    const summary = explorer?.outputProperties?.find((property) => property.name === 'summary');
    expect(summary?.children?.map((child) => child.name)).toEqual([
      'totalRows',
      'totalRevenue',
      'totalUnits',
    ]);
  });

  test('ground truth advertising no output schema yields no output findings', () => {
    const findings = compareSurface(groundTruth.tools, surface ?? { tools: [] });
    expect(findings.some((finding) => finding.rule === 'output-schema-divergence')).toBe(false);
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
