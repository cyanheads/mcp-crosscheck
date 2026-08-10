/**
 * @file src/invariants.test.ts
 * Unit tests for the invariant engine: every rule exercised with hand-built
 * ground-truth/rendered pairs, plus run-level finding assembly.
 */
import { describe, expect, test } from 'bun:test';

import { buildFindings, compareSurface } from './invariants.js';
import { renderedToolFromJsonSchema } from './schema.js';
import type { AdapterRunResult, GroundTruthTool, RenderedSurface } from './types.js';

const gtTool: GroundTruthTool = {
  description: 'Echo a message back.',
  inputSchema: {
    properties: {
      message: {
        description: 'The message to echo.',
        maxLength: 100,
        minLength: 1,
        type: 'string',
      },
      mode: { enum: ['standard', 'uppercase'], type: 'string' },
    },
    required: ['message'],
    type: 'object',
  },
  name: 'echo',
};

function renderedFrom(
  inputSchema: Record<string, unknown>,
  overrides?: {
    description?: string | null;
    name?: string;
  },
): RenderedSurface {
  return {
    tools: [
      renderedToolFromJsonSchema(
        overrides?.name ?? 'echo',
        overrides?.description === undefined ? 'Echo a message back.' : overrides.description,
        inputSchema,
      ),
    ],
  };
}

/** A rendered surface identical to ground truth. */
const faithful = renderedFrom(gtTool.inputSchema);

describe('compareSurface', () => {
  test('faithful rendering produces no findings', () => {
    expect(compareSurface([gtTool], faithful)).toEqual([]);
  });

  test('tool-missing when the rendered surface lacks the tool', () => {
    const findings = compareSurface([gtTool], { tools: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('tool-missing');
    expect(findings[0]?.severity).toBe('fail');
    expect(findings[0]?.path).toBe('echo');
  });

  test('extra rendered tools are ignored', () => {
    const surface: RenderedSurface = {
      tools: [...faithful.tools, renderedToolFromJsonSchema('bonus', null, {})],
    };
    expect(compareSurface([gtTool], surface)).toEqual([]);
  });

  test('empty-request-body when all properties vanish', () => {
    const findings = compareSurface([gtTool], renderedFrom({ type: 'object' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('empty-request-body');
    expect(findings[0]?.severity).toBe('fail');
  });

  test('property-missing when one property vanishes', () => {
    const findings = compareSurface(
      [gtTool],
      renderedFrom({
        properties: {
          message: {
            description: 'The message to echo.',
            maxLength: 100,
            minLength: 1,
            type: 'string',
          },
        },
        required: ['message'],
        type: 'object',
      }),
    );
    expect(findings.map((finding) => finding.rule)).toContain('property-missing');
    expect(findings.find((finding) => finding.rule === 'property-missing')?.path).toBe('echo.mode');
  });

  test('property-untyped when a property loses all type information', () => {
    const findings = compareSurface(
      [gtTool],
      renderedFrom({
        properties: {
          message: { description: 'The message to echo.', maxLength: 100, minLength: 1 },
          mode: { enum: ['standard', 'uppercase'], type: 'string' },
        },
        required: ['message'],
        type: 'object',
      }),
    );
    const untyped = findings.find((finding) => finding.rule === 'property-untyped');
    expect(untyped).toBeDefined();
    expect(untyped?.path).toBe('echo.message');
    expect(untyped?.severity).toBe('fail');
  });

  test('enum alone still counts as type information', () => {
    const findings = compareSurface(
      [gtTool],
      renderedFrom({
        properties: {
          message: {
            description: 'The message to echo.',
            maxLength: 100,
            minLength: 1,
            type: 'string',
          },
          mode: { enum: ['standard', 'uppercase'] },
        },
        required: ['message'],
        type: 'object',
      }),
    );
    expect(findings.map((finding) => finding.rule)).not.toContain('property-untyped');
  });

  test('description-lost at tool and property level', () => {
    const surface = renderedFrom(
      {
        properties: {
          message: { maxLength: 100, minLength: 1, type: 'string' },
          mode: { enum: ['standard', 'uppercase'], type: 'string' },
        },
        required: ['message'],
        type: 'object',
      },
      { description: null },
    );
    const lost = compareSurface([gtTool], surface).filter(
      (finding) => finding.rule === 'description-lost',
    );
    expect(lost.map((finding) => finding.path).sort()).toEqual(['echo', 'echo.message']);
    expect(lost.every((finding) => finding.severity === 'fail')).toBe(true);
  });

  test('required-dropped when the required marker vanishes', () => {
    const findings = compareSurface(
      [gtTool],
      renderedFrom({
        properties: gtTool.inputSchema.properties as Record<string, unknown>,
        type: 'object',
      }),
    );
    const dropped = findings.find((finding) => finding.rule === 'required-dropped');
    expect(dropped).toBeDefined();
    expect(dropped?.detail).toContain('message');
    expect(dropped?.severity).toBe('fail');
  });

  test('constraint-dropped is info severity', () => {
    const findings = compareSurface(
      [gtTool],
      renderedFrom({
        properties: {
          message: { description: 'The message to echo.', type: 'string' },
          mode: { enum: ['standard', 'uppercase'], type: 'string' },
        },
        required: ['message'],
        type: 'object',
      }),
    );
    const dropped = findings.find((finding) => finding.rule === 'constraint-dropped');
    expect(dropped).toBeDefined();
    expect(dropped?.severity).toBe('info');
    expect(dropped?.detail).toContain('maxLength');
    expect(dropped?.detail).toContain('minLength');
    expect(findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
  });

  test('anyof-ignored is info severity', () => {
    const unionTool: GroundTruthTool = {
      description: 'Multi-mode tool.',
      inputSchema: {
        anyOf: [{ required: ['a'] }, { required: ['b'] }],
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        type: 'object',
      },
      name: 'multi',
    };
    const findings = compareSurface([unionTool], {
      tools: [
        renderedToolFromJsonSchema('multi', 'Multi-mode tool.', {
          properties: { a: { type: 'string' }, b: { type: 'string' } },
          type: 'object',
        }),
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('anyof-ignored');
    expect(findings[0]?.severity).toBe('info');
  });
});

describe('buildFindings', () => {
  const base = {
    adapter: 'mcpo',
    canary: null,
    durationMs: 1,
    resolvedVersion: '0.0.20',
  } as const;

  test('adapter-broken collapses to a single fail finding', () => {
    const result: AdapterRunResult = {
      ...base,
      status: 'adapter-broken',
      statusDetail: 'ImportError: cannot import name streamablehttp_client',
      surface: null,
    };
    const findings = buildFindings([gtTool], result);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('adapter-broken');
    expect(findings[0]?.detail).toContain('0.0.20');
    expect(findings[0]?.detail).toContain('ImportError');
  });

  test('handshake-failure collapses to a single fail finding', () => {
    const result: AdapterRunResult = {
      ...base,
      status: 'handshake-failure',
      statusDetail: 'timed out',
      surface: null,
    };
    const findings = buildFindings([gtTool], result);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('handshake-failure');
  });

  test('failed canary appends a canary-failed finding', () => {
    const result: AdapterRunResult = {
      ...base,
      canary: { attempted: true, detail: 'HTTP 422', ok: false },
      status: 'ok',
      statusDetail: null,
      surface: faithful,
    };
    const findings = buildFindings([gtTool], result);
    expect(findings.map((finding) => finding.rule)).toEqual(['canary-failed']);
  });

  test('skipped canary adds nothing', () => {
    const result: AdapterRunResult = {
      ...base,
      canary: { attempted: false, detail: 'capture-only', ok: null },
      status: 'ok',
      statusDetail: null,
      surface: faithful,
    };
    expect(buildFindings([gtTool], result)).toEqual([]);
  });
});
