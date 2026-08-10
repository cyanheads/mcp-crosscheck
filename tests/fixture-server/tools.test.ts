/**
 * @file tests/fixture-server/tools.test.ts
 * Drift guard for the fixture surface. Every tool in the fixture exists to
 * exercise one invariant or type-inference edge; these tests name the shape
 * each tool is responsible for, so a well-meaning edit that flattens a schema
 * fails here instead of silently weakening every suite downstream.
 */
import { describe, expect, test } from 'bun:test';

import { compareSurface } from '../../src/invariants.js';
import { effectiveType, renderedToolFromJsonSchema } from '../../src/schema.js';
import type { GroundTruthTool, RenderedSurface } from '../../src/types.js';
import { FIXTURE_TOOLS } from './tools.js';

const groundTruthTools: GroundTruthTool[] = FIXTURE_TOOLS.map((tool) => ({
  description: tool.description ?? null,
  inputSchema: tool.inputSchema,
  name: tool.name,
}));

const rendered = new Map(
  groundTruthTools.map((tool) => [
    tool.name,
    renderedToolFromJsonSchema(tool.name, tool.description, tool.inputSchema),
  ]),
);

function schemaOf(name: string): Record<string, unknown> {
  const tool = FIXTURE_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`fixture tool "${name}" is gone`);
  return tool.inputSchema;
}

/** Walk a schema literal by key path — a missing hop throws, which is the drift signal. */
function dig(schema: Record<string, unknown>, ...path: string[]): Record<string, unknown> {
  let cursor = schema;
  for (const key of path) {
    cursor = cursor[key] as Record<string, unknown>;
  }
  return cursor;
}

describe('fixture surface', () => {
  test('advertises exactly the six tools the suites depend on', () => {
    expect(FIXTURE_TOOLS.map((tool) => tool.name)).toEqual([
      'echo_message',
      'union_modes',
      'branch_only_fields',
      'nested_config',
      'typed_edges',
      'no_args',
    ]);
  });

  test('every tool carries a description and an object root', () => {
    for (const tool of FIXTURE_TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  test('diffing the fixture against itself is clean', () => {
    const surface: RenderedSurface = { tools: [...rendered.values()] };
    expect(compareSurface(groundTruthTools, surface)).toEqual([]);
  });
});

describe('per-tool shapes', () => {
  test('echo_message carries descriptions, bounds, an enum, and one required field', () => {
    const echo = rendered.get('echo_message');
    expect(echo?.requiredNames).toEqual(['message']);
    const message = echo?.properties.find((property) => property.name === 'message');
    expect(message?.type).toBe('string');
    expect(message?.description).toBeTruthy();
    expect(message?.constraints).toEqual({ maxLength: 200, minLength: 1 });
    expect(echo?.properties.find((property) => property.name === 'mode')?.constraints.enum).toEqual(
      ['standard', 'uppercase'],
    );
    expect(echo?.properties.find((property) => property.name === 'repeat')?.constraints).toEqual({
      maximum: 5,
      minimum: 1,
    });
  });

  test('union_modes keeps a root union alongside root properties', () => {
    const union = rendered.get('union_modes');
    expect(union?.hasRootUnion).toBe(true);
    expect(union?.properties.map((property) => property.name)).toEqual(['a', 'b']);
  });

  test('branch_only_fields declares its fields solely inside anyOf branches', () => {
    const schema = schemaOf('branch_only_fields');
    expect(schema.properties).toBeUndefined();
    expect(schema.anyOf).toHaveLength(2);
    const branchOnly = rendered.get('branch_only_fields');
    expect(branchOnly?.hasRootUnion).toBe(true);
    expect(branchOnly?.properties).toEqual([]);
  });

  test('nested_config nests two levels below the root property', () => {
    const config = dig(schemaOf('nested_config'), 'properties', 'config');
    expect(dig(config, 'properties', 'retries').minimum).toBe(0);
    expect(dig(config, 'properties', 'tags').maxItems).toBe(5);
    expect(dig(config, 'properties', 'transport', 'properties', 'timeoutMs').minimum).toBe(1);
  });

  test('typed_edges covers enum-without-type, const, and type arrays', () => {
    const properties = dig(schemaOf('typed_edges'), 'properties');
    expect(effectiveType(dig(properties, 'kind'), {})).toBe('enum<string>');
    expect(effectiveType(dig(properties, 'version'), {})).toBe('const<number>');
    expect(effectiveType(dig(properties, 'nullable_note'), {})).toBe('null|string');
  });

  test('no_args advertises no input properties at all', () => {
    expect(rendered.get('no_args')?.properties).toEqual([]);
  });
});
