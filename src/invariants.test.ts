/**
 * @file src/invariants.test.ts
 * Unit tests for the invariant engine: every rule exercised with hand-built
 * ground-truth/rendered pairs, plus run-level finding assembly.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { FIXTURE_TOOLS } from '../tests/fixture-server/tools.js';
import {
  buildFindings,
  compareSurface,
  depthLimitedPaths,
  groundTruthFindings,
} from './invariants.js';
import { renderedPropertiesFromJsonSchema, renderedToolFromJsonSchema } from './schema.js';
import type {
  AdapterRunResult,
  Finding,
  GroundTruth,
  GroundTruthTool,
  RenderedSurface,
} from './types.js';

/** A captured SDK v1 `McpServer` surface: draft-07 `$schema` on every input schema. */
const SDK_V1_GROUND_TRUTH = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'tests', 'fixtures', 'ground-truth.json'), 'utf8'),
) as GroundTruth;

/** The bundled fixture server's tools as ground truth captures them. */
const FIXTURE_GROUND_TRUTH: GroundTruthTool[] = FIXTURE_TOOLS.map((tool) => ({
  description: tool.description ?? null,
  inputSchema: tool.inputSchema,
  name: tool.name,
  ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
}));

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

  test('a changed explicit input type fails at its property path', () => {
    const integerTool: GroundTruthTool = {
      description: 'Set a count.',
      inputSchema: {
        properties: { count: { type: 'integer' } },
        type: 'object',
      },
      name: 'set_count',
    };
    const rendered = renderedToolFromJsonSchema('set_count', 'Set a count.', {
      properties: { count: { type: 'string' } },
      type: 'object',
    });

    expect(compareSurface([integerTool], { tools: [rendered] })).toEqual([
      {
        detail: 'property explicit type changed from integer to string',
        evidence: { from: 'integer', kind: 'property-retyped', to: 'string' },
        path: 'set_count.count',
        rule: 'property-retyped',
        severity: 'fail',
      },
    ]);
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

  test('root required comparison preserves declared and undeclared names', () => {
    const gt: GroundTruthTool = {
      description: 'Configure retries.',
      inputSchema: {
        properties: { retries: { type: 'integer' } },
        required: ['retries', 'timeoutMs'],
        type: 'object',
      },
      name: 'configure',
    };
    const rendered = renderedToolFromJsonSchema('configure', 'Configure retries.', {
      properties: { retries: { type: 'integer' } },
      type: 'object',
    });

    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail: 'required marker dropped for: retries, timeoutMs',
        evidence: { kind: 'required-dropped', names: ['retries', 'timeoutMs'] },
        path: 'configure',
        rule: 'required-dropped',
        severity: 'fail',
      },
    ]);
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

  test('equivalent explicit type arrays compare canonically', () => {
    const nullableTool: GroundTruthTool = {
      description: 'Set a nullable label.',
      inputSchema: {
        properties: { label: { type: ['string', 'null'] } },
        type: 'object',
      },
      name: 'set_label',
    };
    const rendered = renderedToolFromJsonSchema('set_label', 'Set a nullable label.', {
      properties: { label: { type: ['null', 'string'] } },
      type: 'object',
    });

    expect(compareSurface([nullableTool], { tools: [rendered] })).toEqual([]);
  });

  test('narrowing an explicit type array is a type change', () => {
    const nullableTool: GroundTruthTool = {
      description: 'Set a nullable label.',
      inputSchema: {
        properties: { label: { type: ['string', 'null'] } },
        type: 'object',
      },
      name: 'set_label',
    };
    const rendered = renderedToolFromJsonSchema('set_label', 'Set a nullable label.', {
      properties: { label: { type: 'string' } },
      type: 'object',
    });

    expect(compareSurface([nullableTool], { tools: [rendered] })).toEqual([
      {
        detail: 'property explicit type changed from null|string to string',
        evidence: { from: 'null|string', kind: 'property-retyped', to: 'string' },
        path: 'set_label.label',
        rule: 'property-retyped',
        severity: 'fail',
      },
    ]);
  });

  test('inferred enum, const, and composition types are not explicit type changes', () => {
    const inferredTool: GroundTruthTool = {
      description: 'Accept inferred schemas.',
      inputSchema: {
        properties: {
          allOfOnly: { allOf: [{ type: 'string' }] },
          anyOfOnly: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          constant: { const: 7 },
          oneOfOnly: { oneOf: [{ type: 'number' }] },
          selected: { enum: ['a', 'b'] },
        },
        type: 'object',
      },
      name: 'inferred',
    };
    const rendered = renderedToolFromJsonSchema('inferred', 'Accept inferred schemas.', {
      properties: {
        allOfOnly: { type: 'string' },
        anyOfOnly: { type: 'string' },
        constant: { type: 'number' },
        oneOfOnly: { type: 'number' },
        selected: { type: 'string' },
      },
      type: 'object',
    });

    expect(
      compareSurface([inferredTool], { tools: [rendered] }).filter(
        (finding) => finding.rule === 'property-retyped',
      ),
    ).toEqual([]);
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

describe('nested comparison', () => {
  const nestedTool: GroundTruthTool = {
    description: 'Open a connection.',
    inputSchema: {
      properties: {
        config: {
          description: 'Connection configuration.',
          properties: {
            retries: { description: 'Retry budget.', maximum: 10, minimum: 0, type: 'integer' },
            tags: {
              description: 'Labels.',
              items: {
                properties: { name: { description: 'Label name.', type: 'string' } },
                type: 'object',
              },
              type: 'array',
            },
            transport: {
              description: 'Transport tuning.',
              properties: {
                timeoutMs: { description: 'Per-request timeout.', minimum: 1, type: 'integer' },
              },
              required: ['timeoutMs'],
              type: 'object',
            },
          },
          required: ['retries'],
          type: 'object',
        },
      },
      required: ['config'],
      type: 'object',
    },
    name: 'connect',
  };

  /** Diff the nested tool against a client rendering of the same root schema. */
  function diff(inputSchema: Record<string, unknown>) {
    return compareSurface([nestedTool], {
      tools: [renderedToolFromJsonSchema('connect', 'Open a connection.', inputSchema)],
    });
  }

  /** The nested tool's own schema, with one sub-property replaced. */
  function withTransport(timeoutMs: Record<string, unknown>, required: string[]) {
    return {
      properties: {
        config: {
          description: 'Connection configuration.',
          properties: {
            retries: { description: 'Retry budget.', maximum: 10, minimum: 0, type: 'integer' },
            tags: {
              description: 'Labels.',
              items: {
                properties: { name: { description: 'Label name.', type: 'string' } },
                type: 'object',
              },
              type: 'array',
            },
            transport: {
              description: 'Transport tuning.',
              properties: { timeoutMs },
              required,
              type: 'object',
            },
          },
          required: ['retries'],
          type: 'object',
        },
      },
      required: ['config'],
      type: 'object',
    };
  }

  const faithfulTimeout = {
    description: 'Per-request timeout.',
    minimum: 1,
    type: 'integer',
  };

  test('a faithful nested rendering produces no findings', () => {
    expect(diff(nestedTool.inputSchema as Record<string, unknown>)).toEqual([]);
  });

  test('property-missing and required-dropped scope to the level that lost them', () => {
    const findings = diff({
      properties: {
        config: {
          description: 'Connection configuration.',
          properties: {
            tags: {
              description: 'Labels.',
              items: {
                properties: { name: { description: 'Label name.', type: 'string' } },
                type: 'object',
              },
              type: 'array',
            },
            transport: {
              description: 'Transport tuning.',
              properties: {
                timeoutMs: { description: 'Per-request timeout.', minimum: 1, type: 'integer' },
              },
              required: ['timeoutMs'],
              type: 'object',
            },
          },
          type: 'object',
        },
      },
      required: ['config'],
      type: 'object',
    });
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['property-missing', 'connect.config.retries'],
      ['required-dropped', 'connect.config'],
    ]);
    expect(findings.every((finding) => finding.severity === 'fail')).toBe(true);
  });

  test('property-untyped at depth 3', () => {
    const findings = diff(
      withTransport({ description: 'Per-request timeout.', minimum: 1 }, ['timeoutMs']),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('property-untyped');
    expect(findings[0]?.path).toBe('connect.config.transport.timeoutMs');
    expect(findings[0]?.detail).toContain('integer');
  });

  test('property-retyped at nested object depth', () => {
    const findings = diff(
      withTransport({ description: 'Per-request timeout.', minimum: 1, type: 'string' }, [
        'timeoutMs',
      ]),
    );
    expect(findings).toEqual([
      {
        detail: 'property explicit type changed from integer to string',
        evidence: { from: 'integer', kind: 'property-retyped', to: 'string' },
        path: 'connect.config.transport.timeoutMs',
        rule: 'property-retyped',
        severity: 'fail',
      },
    ]);
  });

  test('description-lost at depth 3', () => {
    const findings = diff(withTransport({ minimum: 1, type: 'integer' }, ['timeoutMs']));
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['description-lost', 'connect.config.transport.timeoutMs'],
    ]);
  });

  test('constraint-dropped at depth 3 stays info', () => {
    const findings = diff(
      withTransport({ description: 'Per-request timeout.', type: 'integer' }, ['timeoutMs']),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('constraint-dropped');
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.path).toBe('connect.config.transport.timeoutMs');
    expect(findings[0]?.detail).toContain('minimum');
  });

  test('a lost inner required marker scopes to the object that declared it', () => {
    const findings = diff(withTransport(faithfulTimeout, []));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('required-dropped');
    expect(findings[0]?.severity).toBe('fail');
    expect(findings[0]?.path).toBe('connect.config.transport');
    expect(findings[0]?.detail).toContain('timeoutMs');
  });

  test('nested required comparison retains names the object never declares', () => {
    const gt: GroundTruthTool = {
      description: 'Configure retries.',
      inputSchema: {
        properties: {
          config: {
            properties: { retries: { type: 'integer' } },
            required: ['retries', 'timeoutMs'],
            type: 'object',
          },
        },
        type: 'object',
      },
      name: 'configure',
    };
    const rendered = renderedToolFromJsonSchema('configure', 'Configure retries.', {
      properties: {
        config: {
          properties: { retries: { type: 'integer' } },
          type: 'object',
        },
      },
      type: 'object',
    });

    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail: 'required marker dropped for: retries, timeoutMs',
        evidence: { kind: 'required-dropped', names: ['retries', 'timeoutMs'] },
        path: 'configure.config',
        rule: 'required-dropped',
        severity: 'fail',
      },
    ]);

    expect(
      compareSurface([gt], {
        tools: [renderedToolFromJsonSchema('configure', 'Configure retries.', gt.inputSchema)],
      }),
    ).toEqual([]);
  });

  test('a required-only nested object compares its raw required names', () => {
    const gt: GroundTruthTool = {
      description: 'Configure transport.',
      inputSchema: {
        properties: {
          transport: { required: ['timeoutMs'], type: 'object' },
        },
        type: 'object',
      },
      name: 'configure',
    };
    const rendered = renderedToolFromJsonSchema('configure', 'Configure transport.', {
      properties: { transport: { type: 'object' } },
      type: 'object',
    });

    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail: 'required marker dropped for: timeoutMs',
        evidence: { kind: 'required-dropped', names: ['timeoutMs'] },
        path: 'configure.transport',
        rule: 'required-dropped',
        severity: 'fail',
      },
    ]);
  });

  test('a required-only object array item compares its raw required names', () => {
    const gt: GroundTruthTool = {
      description: 'Configure transports.',
      inputSchema: {
        properties: {
          transports: {
            items: { required: ['timeoutMs'], type: 'object' },
            type: 'array',
          },
        },
        type: 'object',
      },
      name: 'configure_many',
    };
    const rendered = renderedToolFromJsonSchema('configure_many', 'Configure transports.', {
      properties: {
        transports: { items: { type: 'object' }, type: 'array' },
      },
      type: 'object',
    });

    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail: 'required marker dropped for: timeoutMs',
        evidence: { kind: 'required-dropped', names: ['timeoutMs'] },
        path: 'configure_many.transports[]',
        rule: 'required-dropped',
        severity: 'fail',
      },
    ]);
  });

  test('old-shape rendered properties stay compatible', () => {
    const gt: GroundTruthTool = {
      description: 'Configure retries.',
      inputSchema: {
        properties: {
          config: {
            properties: { retries: { type: 'integer' } },
            required: ['retries'],
            type: 'object',
          },
        },
        type: 'object',
      },
      name: 'configure',
    };
    const oldShapeSurface: RenderedSurface = {
      tools: [
        {
          description: 'Configure retries.',
          hasRootUnion: false,
          name: 'configure',
          properties: [
            {
              children: [
                {
                  constraints: {},
                  declaredIn: 'root',
                  description: null,
                  name: 'retries',
                  required: false,
                  type: 'string',
                },
              ],
              constraints: {},
              declaredIn: 'root',
              description: null,
              name: 'config',
              required: false,
              type: 'object',
            },
          ],
          requiredNames: [],
        },
      ],
    };

    expect(compareSurface([gt], oldShapeSurface)).toEqual([
      {
        detail: 'required marker dropped for: retries',
        evidence: { kind: 'required-dropped', names: ['retries'] },
        path: 'configure.config',
        rule: 'required-dropped',
        severity: 'fail',
      },
    ]);
  });

  test('array element schemas are compared under a [] path segment', () => {
    const findings = diff({
      properties: {
        config: {
          description: 'Connection configuration.',
          properties: {
            retries: { description: 'Retry budget.', maximum: 10, minimum: 0, type: 'integer' },
            tags: {
              description: 'Labels.',
              items: { properties: { name: {} }, type: 'object' },
              type: 'array',
            },
            transport: {
              description: 'Transport tuning.',
              properties: {
                timeoutMs: { description: 'Per-request timeout.', minimum: 1, type: 'integer' },
              },
              required: ['timeoutMs'],
              type: 'object',
            },
          },
          required: ['retries'],
          type: 'object',
        },
      },
      required: ['config'],
      type: 'object',
    });
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['property-untyped', 'connect.config.tags[].name'],
      ['description-lost', 'connect.config.tags[].name'],
    ]);
  });

  test('property-retyped applies to array item schemas', () => {
    const listTool: GroundTruthTool = {
      description: 'Store values.',
      inputSchema: {
        properties: { values: { items: { type: 'integer' }, type: 'array' } },
        type: 'object',
      },
      name: 'store',
    };
    const rendered = renderedToolFromJsonSchema('store', 'Store values.', {
      properties: { values: { items: { type: 'string' }, type: 'array' } },
      type: 'object',
    });

    expect(compareSurface([listTool], { tools: [rendered] })).toEqual([
      {
        detail: 'property explicit type changed from integer to string',
        evidence: { from: 'integer', kind: 'property-retyped', to: 'string' },
        path: 'store.values[]',
        rule: 'property-retyped',
        severity: 'fail',
      },
    ]);
  });

  test('object-valued array items compare their raw required names', () => {
    const listTool: GroundTruthTool = {
      description: 'Store values.',
      inputSchema: {
        properties: {
          values: {
            items: {
              properties: { value: { type: 'integer' } },
              required: ['value', 'unit'],
              type: 'object',
            },
            type: 'array',
          },
        },
        type: 'object',
      },
      name: 'store',
    };
    const rendered = renderedToolFromJsonSchema('store', 'Store values.', {
      properties: {
        values: {
          items: {
            properties: { value: { type: 'integer' } },
            type: 'object',
          },
          type: 'array',
        },
      },
      type: 'object',
    });

    expect(compareSurface([listTool], { tools: [rendered] })).toEqual([
      {
        detail: 'required marker dropped for: value, unit',
        evidence: { kind: 'required-dropped', names: ['unit', 'value'] },
        path: 'store.values[]',
        rule: 'required-dropped',
        severity: 'fail',
      },
    ]);
  });

  test('an element schema the client never declared is not flagged', () => {
    const base = withTransport(faithfulTimeout, ['timeoutMs']);
    const withTags = (tags: Record<string, unknown>) => ({
      ...base,
      properties: {
        config: {
          ...base.properties.config,
          properties: { ...base.properties.config.properties, tags },
        },
      },
    });
    expect(diff(withTags({ description: 'Labels.', type: 'array' }))).toEqual([]);
    // Control: the same element schema, declared and degraded, is compared.
    const degradedItems = {
      properties: { name: { description: 'Label name.' } },
      type: 'object',
    };
    expect(
      diff(withTags({ description: 'Labels.', items: degradedItems, type: 'array' })).map(
        (finding) => [finding.rule, finding.path],
      ),
    ).toEqual([['property-untyped', 'connect.config.tags[].name']]);
  });

  test('a boolean items schema is an untyped element, like an empty one', () => {
    const ids = (items: unknown) => ({
      properties: { ids: { items, type: 'array' } },
      type: 'object',
    });
    const gt: GroundTruthTool = {
      description: 'T.',
      inputSchema: ids({ type: 'integer' }),
      name: 't',
    };
    for (const items of [true, {}]) {
      const rendered = renderedToolFromJsonSchema('t', 'T.', ids(items));
      expect(
        compareSurface([gt], { tools: [rendered] }).map((finding) => [finding.rule, finding.path]),
      ).toEqual([['property-untyped', 't.ids[]']]);
    }
    const untypedGt: GroundTruthTool = { description: 'T.', inputSchema: ids(true), name: 't' };
    const verbatim = renderedToolFromJsonSchema('t', 'T.', ids(true));
    expect(compareSurface([untypedGt], { tools: [verbatim] })).toEqual([]);
  });

  test('an object rendered with none of its fields collapses to one scoped finding', () => {
    const findings = diff({
      properties: {
        config: { description: 'Connection configuration.', type: 'object' },
      },
      required: ['config'],
      type: 'object',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('empty-request-body');
    expect(findings[0]?.severity).toBe('fail');
    expect(findings[0]?.path).toBe('connect.config');
  });

  test('collapsed input objects suppress raw required-name findings', () => {
    const gt: GroundTruthTool = {
      description: 'Configure retries.',
      inputSchema: {
        properties: {
          config: {
            properties: { retries: { type: 'integer' } },
            required: ['retries', 'timeoutMs'],
            type: 'object',
          },
        },
        type: 'object',
      },
      name: 'configure',
    };
    const rendered = renderedToolFromJsonSchema('configure', 'Configure retries.', {
      properties: { config: { type: 'object' } },
      type: 'object',
    });

    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail:
          'ground truth declares 1 nested property here but the client rendered the object with none — every nested field would be dropped',
        evidence: {
          branchOnly: false,
          expectedPropertyCount: 1,
          kind: 'input-empty',
          scope: 'nested',
        },
        path: 'configure.config',
        rule: 'empty-request-body',
        severity: 'fail',
      },
    ]);
  });

  test('a collapsed object does not abort comparison of its siblings', () => {
    const pairTool: GroundTruthTool = {
      description: 'Two roots.',
      inputSchema: {
        properties: {
          config: { properties: { retries: { type: 'integer' } }, type: 'object' },
          label: { description: 'A label.', type: 'string' },
        },
        type: 'object',
      },
      name: 'pair',
    };
    const findings = compareSurface([pairTool], {
      tools: [
        renderedToolFromJsonSchema('pair', 'Two roots.', {
          properties: { config: { type: 'object' }, label: { type: 'string' } },
          type: 'object',
        }),
      ],
    });
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['empty-request-body', 'pair.config'],
      ['description-lost', 'pair.label'],
    ]);
  });

  test('a structurally recursive schema terminates with bounded findings', () => {
    const recursive: GroundTruthTool = {
      description: 'Walk a tree.',
      inputSchema: {
        $defs: {
          node: {
            properties: { child: { $ref: '#/$defs/node' }, label: { type: 'string' } },
            required: ['label'],
            type: 'object',
          },
        },
        properties: { root: { $ref: '#/$defs/node' } },
        type: 'object',
      },
      name: 'tree',
    };
    const findings = compareSurface([recursive], {
      tools: [
        renderedToolFromJsonSchema('tree', 'Walk a tree.', {
          properties: { root: { type: 'object' } },
          type: 'object',
        }),
      ],
    });
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['empty-request-body', 'tree.root'],
    ]);
  });
});

describe('branch-declared fields', () => {
  const branchTool: GroundTruthTool = {
    description: 'Look something up.',
    inputSchema: {
      anyOf: [
        {
          properties: { by_id: { description: 'By identifier.', type: 'string' } },
          required: ['by_id'],
        },
        {
          properties: { by_name: { description: 'By name.', type: 'string' } },
          required: ['by_name'],
        },
      ],
      type: 'object',
    },
    name: 'lookup',
  };

  function diff(inputSchema: Record<string, unknown>) {
    return compareSurface([branchTool], {
      tools: [renderedToolFromJsonSchema('lookup', 'Look something up.', inputSchema)],
    });
  }

  test('an empty request body for a branch-only tool fails', () => {
    const findings = diff({ type: 'object' });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('empty-request-body');
    expect(findings[0]?.severity).toBe('fail');
    expect(findings[0]?.detail).toContain('anyOf/oneOf branches');
  });

  test('a branch field missing from a rendered union fails, naming the branch origin', () => {
    const findings = diff({
      anyOf: [{ properties: { by_id: { description: 'By identifier.', type: 'string' } } }],
      type: 'object',
    });
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['property-missing', 'lookup.by_name'],
    ]);
    expect(findings[0]?.detail).toContain('anyOf/oneOf branch');
  });

  test('a verbatim rendering of the union diverges nowhere', () => {
    expect(diff(branchTool.inputSchema as Record<string, unknown>)).toEqual([]);
  });

  test('branch fields flattened into root properties keep their required marker unchecked', () => {
    const findings = diff({
      properties: {
        by_id: { description: 'By identifier.', type: 'string' },
        by_name: { description: 'By name.', type: 'string' },
      },
      type: 'object',
    });
    expect(findings.map((finding) => finding.rule)).toEqual(['anyof-ignored']);
  });

  test('a nested level whose own required names a branch-declared field reports the drop', () => {
    const filterBranches = [
      { properties: { mode: { description: 'Filter mode.', type: 'string' } } },
      { properties: { query: { description: 'Query text.', type: 'string' } } },
    ];
    const gt: GroundTruthTool = {
      description: 'Search records.',
      inputSchema: {
        properties: {
          filter: {
            anyOf: filterBranches,
            description: 'Filter selection.',
            required: ['mode'],
            type: 'object',
          },
        },
        type: 'object',
      },
      name: 'search',
    };
    const rendered = renderedToolFromJsonSchema('search', 'Search records.', {
      properties: {
        filter: {
          anyOf: filterBranches,
          description: 'Filter selection.',
          type: 'object',
        },
      },
      type: 'object',
    });
    const findings = compareSurface([gt], { tools: [rendered] });
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['required-dropped', 'search.filter'],
    ]);
    expect(findings[0]?.detail).toContain('mode');
  });
});

describe('output schema rendering', () => {
  const OUTPUT_SCHEMA = {
    properties: {
      attempts: {
        description: 'One entry per attempt.',
        items: {
          properties: { ok: { description: 'Whether it succeeded.', type: 'boolean' } },
          type: 'object',
        },
        type: 'array',
      },
      summary: {
        description: 'Aggregate outcome.',
        properties: { connected: { description: 'Any attempt succeeded.', type: 'boolean' } },
        type: 'object',
      },
    },
    required: ['attempts', 'summary'],
    type: 'object',
  };

  const INPUT_SCHEMA = {
    properties: { url: { description: 'Endpoint to dial.', type: 'string' } },
    type: 'object',
  };

  const outputTool: GroundTruthTool = {
    description: 'Open a connection.',
    inputSchema: INPUT_SCHEMA,
    name: 'connect',
    outputSchema: OUTPUT_SCHEMA,
  };

  /** Diff the tool against a faithful input rendering plus this take on the output model. */
  function diff(outputSchema?: Record<string, unknown>) {
    const rendered = renderedToolFromJsonSchema('connect', 'Open a connection.', INPUT_SCHEMA);
    if (outputSchema !== undefined) {
      rendered.outputProperties = renderedPropertiesFromJsonSchema(outputSchema);
    }
    return compareSurface([outputTool], { tools: [rendered] });
  }

  test('a verbatim output rendering diverges nowhere', () => {
    expect(diff(OUTPUT_SCHEMA)).toEqual([]);
  });

  test('a client with no output surface at all has lost nothing', () => {
    expect(diff()).toEqual([]);
  });

  test('a server advertising no output schema produces no output findings', () => {
    const rendered = renderedToolFromJsonSchema('connect', 'Open a connection.', INPUT_SCHEMA);
    rendered.outputProperties = renderedPropertiesFromJsonSchema(OUTPUT_SCHEMA);
    const withoutOutput: GroundTruthTool = {
      description: outputTool.description,
      inputSchema: INPUT_SCHEMA,
      name: outputTool.name,
    };
    expect(compareSurface([withoutOutput], { tools: [rendered] })).toEqual([]);
  });

  test('a dropped output field is info, scoped under an output: path', () => {
    const findings = diff({
      properties: { summary: OUTPUT_SCHEMA.properties.summary },
      type: 'object',
    });
    expect(findings.map((finding) => [finding.rule, finding.path, finding.severity])).toEqual([
      ['output-schema-divergence', 'output:connect.attempts', 'info'],
    ]);
  });

  test('an untyped output field is info, at the depth that lost the type', () => {
    const findings = diff({
      properties: {
        attempts: { items: { properties: { ok: {} }, type: 'object' }, type: 'array' },
        summary: OUTPUT_SCHEMA.properties.summary,
      },
      type: 'object',
    });
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['output-schema-divergence', 'output:connect.attempts[].ok'],
    ]);
    expect(findings[0]?.detail).toContain('boolean');
  });

  test('nested output fields are compared below the level that declares them', () => {
    const findings = diff({
      properties: {
        attempts: OUTPUT_SCHEMA.properties.attempts,
        summary: {
          description: 'Aggregate outcome.',
          properties: { connected: {} },
          type: 'object',
        },
      },
      type: 'object',
    });
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['output-schema-divergence', 'output:connect.summary.connected'],
    ]);
  });

  test('fully dropped nested output objects collapse at the object path', () => {
    const gt: GroundTruthTool = {
      description: outputTool.description,
      inputSchema: INPUT_SCHEMA,
      name: outputTool.name,
      outputSchema: {
        properties: {
          summary: {
            properties: {
              connected: { type: 'boolean' },
              totalAttempts: { type: 'integer' },
            },
            type: 'object',
          },
        },
        type: 'object',
      },
    };
    const rendered = renderedToolFromJsonSchema('connect', 'Open a connection.', INPUT_SCHEMA);
    rendered.outputProperties = renderedPropertiesFromJsonSchema({
      properties: { summary: { type: 'object' } },
      type: 'object',
    });

    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail:
          'ground truth declares 2 nested output fields here but the client rendered the object with none — every nested output field is absent',
        evidence: { expectedPropertyCount: 2, kind: 'output-nested-empty' },
        path: 'output:connect.summary',
        rule: 'output-schema-divergence',
        severity: 'info',
      },
    ]);
  });

  test('fully dropped object-valued output array items collapse at the [] path', () => {
    const findings = diff({
      properties: {
        attempts: {
          description: 'One entry per attempt.',
          items: { type: 'object' },
          type: 'array',
        },
        summary: OUTPUT_SCHEMA.properties.summary,
      },
      type: 'object',
    });

    expect(findings).toEqual([
      {
        detail:
          'ground truth declares 1 nested output field here but the client rendered the object with none — every nested output field is absent',
        evidence: { expectedPropertyCount: 1, kind: 'output-nested-empty' },
        path: 'output:connect.attempts[]',
        rule: 'output-schema-divergence',
        severity: 'info',
      },
    ]);
  });

  test('partially rendered nested output objects report only missing descendants', () => {
    const gt: GroundTruthTool = {
      description: outputTool.description,
      inputSchema: INPUT_SCHEMA,
      name: outputTool.name,
      outputSchema: {
        properties: {
          summary: {
            properties: {
              connected: { type: 'boolean' },
              totalAttempts: { type: 'integer' },
            },
            type: 'object',
          },
        },
        type: 'object',
      },
    };
    const rendered = renderedToolFromJsonSchema('connect', 'Open a connection.', INPUT_SCHEMA);
    rendered.outputProperties = renderedPropertiesFromJsonSchema({
      properties: {
        summary: {
          properties: { connected: { type: 'boolean' } },
          type: 'object',
        },
      },
      type: 'object',
    });

    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail: 'output field is missing from the rendered result model',
        evidence: { kind: 'output-field-missing' },
        path: 'output:connect.summary.totalAttempts',
        rule: 'output-schema-divergence',
        severity: 'info',
      },
    ]);
  });

  test('an output collapse does not stop comparison of sibling fields', () => {
    const findings = diff({
      properties: {
        attempts: { type: 'string' },
        summary: { type: 'object' },
      },
      type: 'object',
    });

    expect(findings).toEqual([
      {
        detail: 'output field explicit type changed from array to string',
        evidence: { from: 'array', kind: 'output-field-retyped', to: 'string' },
        path: 'output:connect.attempts',
        rule: 'output-schema-divergence',
        severity: 'info',
      },
      {
        detail:
          'ground truth declares 1 nested output field here but the client rendered the object with none — every nested output field is absent',
        evidence: { expectedPropertyCount: 1, kind: 'output-nested-empty' },
        path: 'output:connect.summary',
        rule: 'output-schema-divergence',
        severity: 'info',
      },
    ]);
  });

  test('changed explicit output types stay info at nested depth', () => {
    const findings = diff({
      properties: {
        attempts: OUTPUT_SCHEMA.properties.attempts,
        summary: {
          description: 'Aggregate outcome.',
          properties: {
            connected: { description: 'Any attempt succeeded.', type: 'string' },
          },
          type: 'object',
        },
      },
      type: 'object',
    });

    expect(findings).toEqual([
      {
        detail: 'output field explicit type changed from boolean to string',
        evidence: { from: 'boolean', kind: 'output-field-retyped', to: 'string' },
        path: 'output:connect.summary.connected',
        rule: 'output-schema-divergence',
        severity: 'info',
      },
    ]);
  });

  test('an output model rendered with none of its fields collapses to one finding', () => {
    const findings = diff({ type: 'object' });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('output:connect');
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.detail).toContain('2 output properties');
  });

  test('output divergence never fails a run', () => {
    const rendered = renderedToolFromJsonSchema('connect', 'Open a connection.', INPUT_SCHEMA);
    rendered.outputProperties = [];
    const findings = buildFindings([outputTool], {
      adapter: 'mcpo',
      canary: null,
      durationMs: 1,
      resolvedVersion: '0.0.20',
      status: 'ok',
      statusDetail: null,
      surface: { tools: [rendered] },
    });
    expect(findings.map((finding) => [finding.rule, finding.severity])).toEqual([
      ['output-schema-divergence', 'info'],
    ]);
  });
});

describe('untyped ground truth', () => {
  test('an untyped advertised property rendered untyped is faithful', () => {
    const groundTruth: GroundTruthTool[] = [
      {
        description: 'Echo.',
        inputSchema: { properties: { payload: { description: 'Anything.' } }, type: 'object' },
        name: 'echo',
      },
    ];
    const rendered = renderedToolFromJsonSchema('echo', 'Echo.', {
      properties: { payload: { description: 'Anything.' } },
      type: 'object',
    });
    expect(compareSurface(groundTruth, { tools: [rendered] })).toEqual([]);
  });

  test('untyped nested fields and array items rendered untyped produce nothing', () => {
    const inputSchema = {
      properties: {
        config: { properties: { extra: { description: 'Opaque.' } }, type: 'object' },
        records: { items: { properties: { blob: {} }, type: 'object' }, type: 'array' },
        values: { items: { description: 'Any value.' }, type: 'array' },
      },
      type: 'object',
    };
    const gt: GroundTruthTool = { description: 'Store.', inputSchema, name: 'store' };
    const rendered = renderedToolFromJsonSchema('store', 'Store.', inputSchema);
    expect(compareSurface([gt], { tools: [rendered] })).toEqual([]);
  });

  test('a typed advertisement rendered untyped still fails at every depth', () => {
    const gt: GroundTruthTool = {
      description: 'Store.',
      inputSchema: {
        properties: {
          config: { properties: { extra: { type: 'string' } }, type: 'object' },
          label: { type: ['null', 'string'] },
          values: { items: { type: 'integer' }, type: 'array' },
        },
        type: 'object',
      },
      name: 'store',
    };
    const rendered = renderedToolFromJsonSchema('store', 'Store.', {
      properties: {
        config: { properties: { extra: {} }, type: 'object' },
        label: {},
        values: { items: {}, type: 'array' },
      },
      type: 'object',
    });
    const findings = compareSurface([gt], { tools: [rendered] });
    expect(findings.map((finding) => [finding.path, finding.severity, finding.evidence])).toEqual([
      ['store.config.extra', 'fail', { groundTruthType: 'string', kind: 'property-untyped' }],
      ['store.label', 'fail', { groundTruthType: 'null|string', kind: 'property-untyped' }],
      ['store.values[]', 'fail', { groundTruthType: 'integer', kind: 'property-untyped' }],
    ]);
    expect(findings[0]?.detail).toBe(
      'property rendered with no type information (ground truth: string)',
    );
  });

  test('output fields skip untyped ground truth and keep typed drift at info', () => {
    const gt: GroundTruthTool = {
      description: 'Return a result.',
      inputSchema: { type: 'object' },
      name: 'result',
      outputSchema: {
        properties: {
          count: { type: 'integer' },
          payload: { description: 'Opaque.' },
          rows: { items: {}, type: 'array' },
        },
        type: 'object',
      },
    };
    const rendered = renderedToolFromJsonSchema('result', 'Return a result.', { type: 'object' });
    rendered.outputProperties = renderedPropertiesFromJsonSchema({
      properties: { count: {}, payload: {}, rows: { items: {}, type: 'array' } },
      type: 'object',
    });
    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail: 'output field rendered with no type information (ground truth: integer)',
        evidence: { groundTruthType: 'integer', kind: 'output-field-untyped' },
        path: 'output:result.count',
        rule: 'output-schema-divergence',
        severity: 'info',
      },
    ]);
  });

  test('boolean property schemas are untyped, so a verbatim or an empty-schema rendering is faithful', () => {
    const inputSchema = {
      properties: {
        items: { items: true, type: 'array' },
        nested: { properties: { inner: true }, type: 'object' },
        off: false,
        payload: true,
      },
      required: ['payload'],
      type: 'object',
    };
    const gt: GroundTruthTool = { description: 'Accept anything.', inputSchema, name: 'any' };
    const verbatim = renderedToolFromJsonSchema('any', 'Accept anything.', inputSchema);
    const emptySchemas = renderedToolFromJsonSchema('any', 'Accept anything.', {
      ...inputSchema,
      properties: {
        items: { items: {}, type: 'array' },
        nested: { properties: { inner: {} }, type: 'object' },
        off: {},
        payload: {},
      },
    });
    expect(compareSurface([gt], { tools: [verbatim] })).toEqual([]);
    expect(compareSurface([gt], { tools: [emptySchemas] })).toEqual([]);
  });
});

describe('description comparison', () => {
  test('a description rendered as an empty string is lost at tool and property level', () => {
    const groundTruth: GroundTruthTool[] = [
      {
        description: 'Echo a message.',
        inputSchema: {
          properties: { m: { description: 'The message.', type: 'string' } },
          type: 'object',
        },
        name: 'echo',
      },
    ];
    const rendered = renderedToolFromJsonSchema('echo', '', {
      properties: { m: { description: '', type: 'string' } },
      type: 'object',
    });
    expect(compareSurface(groundTruth, { tools: [rendered] })).toEqual([
      {
        detail: 'tool description was lost in rendering',
        evidence: { kind: 'description-lost', subject: 'tool' },
        path: 'echo',
        rule: 'description-lost',
        severity: 'fail',
      },
      {
        detail: 'property description was lost in rendering',
        evidence: { kind: 'description-lost', subject: 'property' },
        path: 'echo.m',
        rule: 'description-lost',
        severity: 'fail',
      },
    ]);
  });

  test('a whitespace-only description is lost at root, nested, and array-item depth', () => {
    const gt: GroundTruthTool = {
      description: 'Tidy records.',
      inputSchema: {
        properties: {
          config: {
            description: 'Settings.',
            properties: { mode: { description: 'Run mode.', type: 'string' } },
            type: 'object',
          },
          tags: {
            description: 'Labels.',
            items: { description: 'One label.', type: 'string' },
            type: 'array',
          },
        },
        type: 'object',
      },
      name: 'tidy',
    };
    const rendered = renderedToolFromJsonSchema('tidy', ' \n', {
      properties: {
        config: {
          description: '\t',
          properties: { mode: { description: '   ', type: 'string' } },
          type: 'object',
        },
        tags: { description: '\r\n', items: { description: ' ', type: 'string' }, type: 'array' },
      },
      type: 'object',
    });
    const findings = compareSurface([gt], { tools: [rendered] });
    expect(findings.map((finding) => [finding.rule, finding.path, finding.severity])).toEqual([
      ['description-lost', 'tidy', 'fail'],
      ['description-lost', 'tidy.config', 'fail'],
      ['description-lost', 'tidy.config.mode', 'fail'],
      ['description-lost', 'tidy.tags', 'fail'],
      ['description-lost', 'tidy.tags[]', 'fail'],
    ]);
  });

  test('an empty or whitespace-only advertised description has nothing to lose', () => {
    const gt: GroundTruthTool = {
      description: '',
      inputSchema: {
        properties: {
          blank: { description: '', type: 'string' },
          spaced: { description: ' \n ', type: 'string' },
        },
        type: 'object',
      },
      name: 'quiet',
    };
    for (const description of [null, '', '  ']) {
      const rendered = renderedToolFromJsonSchema('quiet', description, {
        properties: {
          blank: { type: 'string', ...(description === null ? {} : { description }) },
          spaced: { type: 'string', ...(description === null ? {} : { description }) },
        },
        type: 'object',
      });
      expect(compareSurface([gt], { tools: [rendered] })).toEqual([]);
    }
  });

  test('a truncated description is reported at tool and property level', () => {
    const groundTruth: GroundTruthTool[] = [
      {
        description: 'A'.repeat(200),
        inputSchema: {
          properties: { a: { description: 'B'.repeat(200), type: 'string' } },
          type: 'object',
        },
        name: 't',
      },
    ];
    const rendered = renderedToolFromJsonSchema('t', 'A'.repeat(20), {
      properties: { a: { description: 'B'.repeat(20), type: 'string' } },
      type: 'object',
    });
    expect(compareSurface(groundTruth, { tools: [rendered] })).toEqual([
      {
        detail: 'tool description was truncated in rendering (20 of 200 characters kept)',
        evidence: { change: 'truncated', kind: 'description-altered', subject: 'tool' },
        path: 't',
        rule: 'description-altered',
        severity: 'info',
      },
      {
        detail: 'property description was truncated in rendering (20 of 200 characters kept)',
        evidence: { change: 'truncated', kind: 'description-altered', subject: 'property' },
        path: 't.a',
        rule: 'description-altered',
        severity: 'info',
      },
    ]);
  });

  test('a shortened nested description and a replaced array-item description report at their paths', () => {
    const gt: GroundTruthTool = {
      description: 'Tidy records.',
      inputSchema: {
        properties: {
          config: {
            properties: { mode: { description: 'Run mode: fast or thorough.', type: 'string' } },
            type: 'object',
          },
          tags: { items: { description: 'One label.', type: 'string' }, type: 'array' },
        },
        type: 'object',
      },
      name: 'tidy',
    };
    const rendered = renderedToolFromJsonSchema('tidy', 'Tidy records.', {
      properties: {
        config: {
          properties: { mode: { description: 'Run mode:', type: 'string' } },
          type: 'object',
        },
        tags: { items: { description: 'A tag.', type: 'string' }, type: 'array' },
      },
      type: 'object',
    });
    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail: 'property description was truncated in rendering (9 of 27 characters kept)',
        evidence: { change: 'truncated', kind: 'description-altered', subject: 'property' },
        path: 'tidy.config.mode',
        rule: 'description-altered',
        severity: 'info',
      },
      {
        detail:
          'property description was rewritten in rendering (10 characters advertised, 6 rendered)',
        evidence: { change: 'rewritten', kind: 'description-altered', subject: 'property' },
        path: 'tidy.tags[]',
        rule: 'description-altered',
        severity: 'info',
      },
    ]);
  });

  test('a prefix followed by a trailing truncation marker is truncated at every depth', () => {
    const advertised = 'Maximum number of results to return per page.';
    const rendered = {
      bracket: 'Maximum number of res[truncated]',
      both: 'Maximum number of results… [truncated]',
      dots: 'Maximum number of results ...',
      ellipsis: 'Maximum number of results…',
      wrapped: 'Maximum number\n… [truncated]',
    };
    const schemaOf = (descriptions: Record<string, string>) => ({
      properties: {
        ...Object.fromEntries(
          Object.entries(descriptions).map(([name, description]) => [
            name,
            { description, type: 'string' },
          ]),
        ),
        pages: { items: { description: descriptions.ellipsis, type: 'string' }, type: 'array' },
      },
      type: 'object',
    });
    const gt: GroundTruthTool = {
      description: 'A'.repeat(4712),
      inputSchema: schemaOf(Object.fromEntries(Object.keys(rendered).map((n) => [n, advertised]))),
      name: 'search',
    };
    // Claude Code 2.1.283 keeps the first 2,048 characters and appends `… [truncated]`.
    const claudeCodeCut = `${'A'.repeat(2048)}… [truncated]`;
    const findings = compareSurface([gt], {
      tools: [renderedToolFromJsonSchema('search', claudeCodeCut, schemaOf(rendered))],
    });
    expect(findings.map((finding) => [finding.path, finding.evidence, finding.detail])).toEqual([
      [
        'search',
        { change: 'truncated', kind: 'description-altered', subject: 'tool' },
        'tool description was truncated in rendering (2048 of 4712 characters kept)',
      ],
      ...[
        ['bracket', 21],
        ['both', 25],
        ['dots', 25],
        ['ellipsis', 25],
        ['wrapped', 14],
        ['pages[]', 25],
      ].map(([name, kept]) => [
        `search.${name}`,
        { change: 'truncated', kind: 'description-altered', subject: 'property' } as const,
        `property description was truncated in rendering (${kept} of 45 characters kept)`,
      ]),
    ]);
  });

  test('any other suffix, or a marker after text that is not a prefix, stays rewritten', () => {
    const advertised = 'Maximum number of results to return per page.';
    const rendered = {
      glued: 'Maximum number of results…[truncated]',
      midText: 'Maximum … [truncated] number of results',
      notPrefix: 'Max results…',
      parenthesized: 'Maximum number of results (truncated)',
      twoDots: 'Maximum number of results..',
    };
    const schemaOf = (descriptions: Record<string, string>) => ({
      properties: Object.fromEntries(
        Object.entries(descriptions).map(([name, description]) => [
          name,
          { description, type: 'string' },
        ]),
      ),
      type: 'object',
    });
    const gt: GroundTruthTool = {
      description: 'Search.',
      inputSchema: schemaOf(Object.fromEntries(Object.keys(rendered).map((n) => [n, advertised]))),
      name: 'search',
    };
    const findings = compareSurface([gt], {
      tools: [renderedToolFromJsonSchema('search', 'Search.', schemaOf(rendered))],
    });
    expect(findings.map((finding) => [finding.path, finding.evidence])).toEqual(
      Object.keys(rendered).map((name) => [
        `search.${name}`,
        { change: 'rewritten', kind: 'description-altered', subject: 'property' },
      ]),
    );
  });

  test('whitespace-only differences and client-added text keep the advertised description', () => {
    const advertised = {
      appended: 'Page to fetch.',
      crlf: 'First line.\r\nSecond line.',
      prefixed: 'Maximum pages.',
      reflowed: 'Fetch a page and\nreturn it as markdown.',
      trimmed: 'Timeout in seconds.\n',
    };
    const rendered = {
      appended: 'Page to fetch. Must be absolute.',
      crlf: 'First line.\nSecond line.',
      prefixed: '(integer) Maximum pages.',
      reflowed: 'Fetch a page\nand return it as\n  markdown.',
      trimmed: 'Timeout in seconds.',
    };
    const schemaOf = (descriptions: Record<string, string>) => ({
      properties: Object.fromEntries(
        Object.entries(descriptions).map(([name, description]) => [
          name,
          { description, type: 'string' },
        ]),
      ),
      type: 'object',
    });
    const gt: GroundTruthTool = {
      description: 'Fetch a page.\n',
      inputSchema: schemaOf(advertised),
      name: 'fetch',
    };
    const faithfulText = renderedToolFromJsonSchema(
      'fetch',
      '[mcp] Fetch a page. Read-only.',
      schemaOf(rendered),
    );
    expect(compareSurface([gt], { tools: [faithfulText] })).toEqual([]);
  });

  test('a null rendering is only lost; an empty one is lost, never altered', () => {
    const gt: GroundTruthTool = {
      description: 'Look up a record.',
      inputSchema: { properties: { id: { description: 'Record id.', type: 'string' } } },
      name: 'lookup',
    };
    for (const description of [null, '', ' \t ']) {
      const rendered = renderedToolFromJsonSchema('lookup', description, {
        properties: {
          id: { type: 'string', ...(description === null ? {} : { description }) },
        },
      });
      expect(
        compareSurface([gt], { tools: [rendered] }).map((finding) => [finding.rule, finding.path]),
      ).toEqual([
        ['description-lost', 'lookup'],
        ['description-lost', 'lookup.id'],
      ]);
    }
  });

  test('an altered description is info and never fails a run', () => {
    const rendered = renderedToolFromJsonSchema('echo', 'Echo a message', {
      properties: {
        message: { description: 'Text.', maxLength: 100, minLength: 1, type: 'string' },
        mode: { enum: ['standard', 'uppercase'], type: 'string' },
      },
      required: ['message'],
      type: 'object',
    });
    const findings = buildFindings([gtTool], {
      adapter: 'inspector',
      canary: null,
      durationMs: 1,
      resolvedVersion: '2.1.0',
      status: 'ok',
      statusDetail: null,
      surface: { tools: [rendered] },
    });
    expect(findings.map((finding) => [finding.rule, finding.severity, finding.evidence])).toEqual([
      [
        'description-altered',
        'info',
        { change: 'truncated', kind: 'description-altered', subject: 'tool' },
      ],
      [
        'description-altered',
        'info',
        { change: 'rewritten', kind: 'description-altered', subject: 'property' },
      ],
    ]);
  });
});

describe('constraint value comparison', () => {
  test('changed bounds are one info finding naming each keyword', () => {
    const groundTruth: GroundTruthTool[] = [
      {
        description: 'Set.',
        inputSchema: {
          properties: { n: { maximum: 100, minimum: 5, type: 'integer' } },
          type: 'object',
        },
        name: 'set',
      },
    ];
    const rendered = renderedToolFromJsonSchema('set', 'Set.', {
      properties: { n: { maximum: 3, minimum: 0, type: 'integer' } },
      type: 'object',
    });
    expect(compareSurface(groundTruth, { tools: [rendered] })).toEqual([
      {
        detail: 'constraint values changed: maximum 100 → 3, minimum 5 → 0',
        evidence: { keywords: ['maximum', 'minimum'], kind: 'constraint-altered' },
        path: 'set.n',
        rule: 'constraint-altered',
        severity: 'info',
      },
    ]);
  });

  test('a narrowed nested enum and a changed array-item maxLength report at their paths', () => {
    const gt: GroundTruthTool = {
      description: 'Query logs.',
      inputSchema: {
        properties: {
          filter: {
            properties: { level: { enum: ['debug', 'info', 'warn'], type: 'string' } },
            type: 'object',
          },
          names: { items: { maxLength: 64, type: 'string' }, type: 'array' },
        },
        type: 'object',
      },
      name: 'logs',
    };
    const rendered = renderedToolFromJsonSchema('logs', 'Query logs.', {
      properties: {
        filter: {
          properties: { level: { enum: ['info', 'warn'], type: 'string' } },
          type: 'object',
        },
        names: { items: { maxLength: 32, type: 'string' }, type: 'array' },
      },
      type: 'object',
    });
    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail: 'constraint value changed: enum ["debug","info","warn"] → ["info","warn"]',
        evidence: { keywords: ['enum'], kind: 'constraint-altered' },
        path: 'logs.filter.level',
        rule: 'constraint-altered',
        severity: 'info',
      },
      {
        detail: 'constraint value changed: maxLength 64 → 32',
        evidence: { keywords: ['maxLength'], kind: 'constraint-altered' },
        path: 'logs.names[]',
        rule: 'constraint-altered',
        severity: 'info',
      },
    ]);
  });

  test('re-encodings that keep the constraint produce no finding', () => {
    const gt: GroundTruthTool = {
      description: 'Configure.',
      inputSchema: {
        properties: {
          bag: { additionalProperties: { type: 'string' }, type: 'object' },
          bound: { exclusiveMinimum: 0, type: 'number' },
          duplicated: { enum: ['a', 'b'], type: 'string' },
          reordered: { enum: ['a', 'b', 'c'], type: 'string' },
          shape: { const: { x: 1, y: [1, { p: 1, q: 2 }] } },
          titled: { additionalProperties: { type: 'string' }, type: 'object' },
        },
        type: 'object',
      },
      name: 'configure',
    };
    const rendered = renderedToolFromJsonSchema('configure', 'Configure.', {
      $defs: { Str: { type: 'string' } },
      properties: {
        bag: { additionalProperties: { $ref: '#/$defs/Str' }, type: 'object' },
        bound: { exclusiveMinimum: true, minimum: 0, type: 'number' },
        duplicated: { enum: ['a', 'b', 'a'], type: 'string' },
        reordered: { enum: ['c', 'a', 'b'], type: 'string' },
        shape: { const: { y: [1, { q: 2, p: 1 }], x: 1 } },
        titled: { additionalProperties: { title: 'Titled', type: 'string' }, type: 'object' },
      },
      type: 'object',
    });
    expect(compareSurface([gt], { tools: [rendered] })).toEqual([]);
  });

  test('a draft-4 exclusive bound rendered numerically drops a keyword but changes none', () => {
    const gt: GroundTruthTool = {
      description: 'Configure.',
      inputSchema: {
        properties: { bound: { exclusiveMinimum: true, minimum: 0, type: 'number' } },
        type: 'object',
      },
      name: 'configure',
    };
    const rendered = renderedToolFromJsonSchema('configure', 'Configure.', {
      properties: { bound: { exclusiveMinimum: 0, type: 'number' } },
      type: 'object',
    });
    expect(
      compareSurface([gt], { tools: [rendered] }).map((finding) => [
        finding.rule,
        finding.evidence,
      ]),
    ).toEqual([['constraint-dropped', { keywords: ['minimum'], kind: 'constraint-dropped' }]]);
  });

  test('a flipped boolean additionalProperties and a changed pattern are reported', () => {
    const gt: GroundTruthTool = {
      description: 'Register.',
      inputSchema: {
        properties: {
          code: { pattern: '^[A-Z]{3}$', type: 'string' },
          options: {
            additionalProperties: false,
            properties: { verbose: { type: 'boolean' } },
            type: 'object',
          },
        },
        type: 'object',
      },
      name: 'register',
    };
    const rendered = renderedToolFromJsonSchema('register', 'Register.', {
      properties: {
        code: { pattern: '^[A-Z]+$', type: 'string' },
        options: {
          additionalProperties: true,
          properties: { verbose: { type: 'boolean' } },
          type: 'object',
        },
      },
      type: 'object',
    });
    expect(
      compareSurface([gt], { tools: [rendered] }).map((finding) => [finding.path, finding.detail]),
    ).toEqual([
      ['register.code', 'constraint value changed: pattern "^[A-Z]{3}$" → "^[A-Z]+$"'],
      ['register.options', 'constraint value changed: additionalProperties false → true'],
    ]);
  });

  test('a map or closed object rendered open is a loosening at every depth', () => {
    const gt: GroundTruthTool = {
      description: 'Configure.',
      inputSchema: {
        properties: {
          config: {
            properties: { env: { additionalProperties: { type: 'string' }, type: 'object' } },
            type: 'object',
          },
          labels: { additionalProperties: { type: 'string' }, type: 'object' },
          rows: { items: { additionalProperties: false, type: 'object' }, type: 'array' },
          strict: { additionalProperties: false, type: 'object' },
        },
        type: 'object',
      },
      name: 'configure',
    };
    const rendered = renderedToolFromJsonSchema('configure', 'Configure.', {
      properties: {
        config: {
          properties: { env: { additionalProperties: {}, type: 'object' } },
          type: 'object',
        },
        labels: { additionalProperties: true, type: 'object' },
        rows: { items: { additionalProperties: true, type: 'object' }, type: 'array' },
        strict: { additionalProperties: {}, type: 'object' },
      },
      type: 'object',
    });
    expect(compareSurface([gt], { tools: [rendered] })).toEqual(
      [
        ['configure.config.env', '{"type":"string"} → {}'],
        ['configure.labels', '{"type":"string"} → true'],
        ['configure.rows[]', 'false → true'],
        ['configure.strict', 'false → {}'],
      ].map(([path, change]) => ({
        detail: `constraint value changed: additionalProperties ${change}`,
        evidence: { keywords: ['additionalProperties'], kind: 'constraint-altered' },
        path: path!,
        rule: 'constraint-altered',
        severity: 'info',
      })),
    );
  });

  test('an open map rendered open another way, or a map schema rendered as another schema, changes nothing', () => {
    const gt: GroundTruthTool = {
      description: 'Configure.',
      inputSchema: {
        properties: {
          annotated: { additionalProperties: { description: 'Any value.' }, type: 'object' },
          anything: { additionalProperties: true, type: 'object' },
          empty: { additionalProperties: {}, type: 'object' },
          retyped: { additionalProperties: { type: 'string' }, type: 'object' },
        },
        type: 'object',
      },
      name: 'configure',
    };
    const rendered = renderedToolFromJsonSchema('configure', 'Configure.', {
      properties: {
        annotated: { additionalProperties: true, type: 'object' },
        anything: { additionalProperties: {}, type: 'object' },
        empty: { additionalProperties: true, type: 'object' },
        retyped: { additionalProperties: { type: 'integer' }, type: 'object' },
      },
      type: 'object',
    });
    expect(compareSurface([gt], { tools: [rendered] })).toEqual([]);
  });

  test('a dropped keyword and a changed one report one finding each', () => {
    const gt: GroundTruthTool = {
      description: 'Set.',
      inputSchema: {
        properties: { n: { maximum: 10, minimum: 1, type: 'integer' } },
        type: 'object',
      },
      name: 'set',
    };
    const rendered = renderedToolFromJsonSchema('set', 'Set.', {
      properties: { n: { maximum: 20, type: 'integer' } },
      type: 'object',
    });
    expect(
      compareSurface([gt], { tools: [rendered] }).map((finding) => [
        finding.rule,
        finding.severity,
        finding.evidence,
      ]),
    ).toEqual([
      ['constraint-dropped', 'info', { keywords: ['minimum'], kind: 'constraint-dropped' }],
      ['constraint-altered', 'info', { keywords: ['maximum'], kind: 'constraint-altered' }],
    ]);
  });

  test('a changed constraint value never fails a run', () => {
    const rendered = renderedToolFromJsonSchema('echo', 'Echo a message back.', {
      properties: {
        message: {
          description: 'The message to echo.',
          maxLength: 10,
          minLength: 1,
          type: 'string',
        },
        mode: { enum: ['standard'], type: 'string' },
      },
      required: ['message'],
      type: 'object',
    });
    const findings = buildFindings([gtTool], {
      adapter: 'inspector',
      canary: null,
      durationMs: 1,
      resolvedVersion: '2.1.0',
      status: 'ok',
      statusDetail: null,
      surface: { tools: [rendered] },
    });
    expect(findings.map((finding) => [finding.rule, finding.path, finding.severity])).toEqual([
      ['constraint-altered', 'echo.message', 'info'],
      ['constraint-altered', 'echo.mode', 'info'],
    ]);
  });
});

describe('closed levels and allOf constraints', () => {
  test('a closed level whose fields are all declared in its own properties diverges nowhere', () => {
    const inputSchema = {
      additionalProperties: false,
      properties: {
        options: {
          additionalProperties: false,
          properties: { verbose: { type: 'boolean' } },
          type: 'object',
        },
        query: { type: 'string' },
      },
      type: 'object',
    };
    const gt: GroundTruthTool = { description: 'Search.', inputSchema, name: 'search' };
    expect(
      compareSurface([gt], {
        tools: [renderedToolFromJsonSchema('search', 'Search.', inputSchema)],
      }),
    ).toEqual([]);
  });

  test('a closed anyOf branch excludes nothing at the level that holds it', () => {
    const inputSchema = {
      anyOf: [
        {
          additionalProperties: false,
          properties: { by_id: { type: 'string' } },
          required: ['by_id'],
        },
        { properties: { by_name: { type: 'string' } }, required: ['by_name'] },
      ],
      type: 'object',
    };
    const gt: GroundTruthTool = { description: 'Look up.', inputSchema, name: 'lookup' };
    expect(
      compareSurface([gt], {
        tools: [renderedToolFromJsonSchema('lookup', 'Look up.', inputSchema)],
      }),
    ).toEqual([]);
  });

  test('a multi-member allOf constraint is not compared as the property’s own', () => {
    const gt: GroundTruthTool = {
      description: 'Pick.',
      inputSchema: {
        properties: {
          choice: { allOf: [{ enum: ['a', 'b'] }, { minLength: 1 }], type: 'string' },
        },
        type: 'object',
      },
      name: 'pick',
    };
    for (const choice of [
      { enum: ['a'], type: 'string' },
      { allOf: [{ enum: ['a'] }, { minLength: 2 }], type: 'string' },
      { type: 'string' },
    ]) {
      const rendered = renderedToolFromJsonSchema('pick', 'Pick.', {
        properties: { choice },
        type: 'object',
      });
      expect(compareSurface([gt], { tools: [rendered] })).toEqual([]);
    }
  });
});

describe('allOf composition', () => {
  const ticket: GroundTruthTool = {
    description: 'Create a ticket.',
    inputSchema: {
      allOf: [
        { properties: { title: { type: 'string' } }, required: ['title'] },
        { properties: { priority: { type: 'integer' } } },
      ],
      type: 'object',
    },
    name: 'create_ticket',
  };

  function diff(inputSchema: Record<string, unknown>) {
    return compareSurface([ticket], {
      tools: [renderedToolFromJsonSchema('create_ticket', 'Create a ticket.', inputSchema)],
    });
  }

  test('a rendering that drops every allOf-declared argument is an empty request body', () => {
    expect(diff({ properties: {}, type: 'object' })).toEqual([
      {
        detail:
          'ground truth advertises 2 input properties but the client rendered an empty request body — every argument would be dropped',
        evidence: {
          branchOnly: false,
          expectedPropertyCount: 2,
          kind: 'input-empty',
          scope: 'root',
        },
        path: 'create_ticket',
        rule: 'empty-request-body',
        severity: 'fail',
      },
    ]);
    expect(diff(ticket.inputSchema)).toEqual([]);
  });

  test('an allOf member’s required marker is unconditional', () => {
    const flattened = {
      properties: { priority: { type: 'integer' }, title: { type: 'string' } },
      type: 'object',
    };
    expect(diff(flattened)).toEqual([
      {
        detail: 'required marker dropped for: title',
        evidence: { kind: 'required-dropped', names: ['title'] },
        path: 'create_ticket',
        rule: 'required-dropped',
        severity: 'fail',
      },
    ]);
    expect(diff({ ...flattened, required: ['title'] })).toEqual([]);
  });

  test('fields inside a described $ref wrapped in allOf are compared', () => {
    const withConfig = (fields: Record<string, unknown>) => ({
      $defs: { config: { properties: fields, required: ['retries'], type: 'object' } },
      properties: { config: { allOf: [{ $ref: '#/$defs/config' }], description: 'Settings.' } },
      type: 'object',
    });
    const gt: GroundTruthTool = {
      description: 'Connect.',
      inputSchema: withConfig({ retries: { type: 'integer' }, timeoutMs: { type: 'integer' } }),
      name: 'connect',
    };
    const render = (inputSchema: Record<string, unknown>) =>
      compareSurface([gt], {
        tools: [renderedToolFromJsonSchema('connect', 'Connect.', inputSchema)],
      });
    expect(
      render(withConfig({ retries: { type: 'integer' } })).map((finding) => [
        finding.rule,
        finding.path,
      ]),
    ).toEqual([['property-missing', 'connect.config.timeoutMs']]);
    expect(render(gt.inputSchema)).toEqual([]);
  });

  test('an object rendered as a described $ref wrapped in allOf keeps its fields', () => {
    const gt: GroundTruthTool = {
      description: 'Connect.',
      inputSchema: {
        properties: {
          config: {
            description: 'Settings.',
            properties: { retries: { type: 'integer' } },
            required: ['retries'],
            type: 'object',
          },
        },
        type: 'object',
      },
      name: 'connect',
    };
    const rendered = renderedToolFromJsonSchema('connect', 'Connect.', {
      $defs: {
        config: {
          properties: { retries: { type: 'integer' } },
          required: ['retries'],
          type: 'object',
        },
      },
      properties: { config: { allOf: [{ $ref: '#/$defs/config' }], description: 'Settings.' } },
      type: 'object',
    });
    expect(compareSurface([gt], { tools: [rendered] })).toEqual([]);
  });

  test('a one-member allOf around a $ref carries its target’s values at every depth', () => {
    const color = (enumValues: string[]) => ({ enum: enumValues, type: 'string' });
    const gt: GroundTruthTool = {
      description: 'Paint.',
      inputSchema: {
        properties: {
          color: { description: 'Color.', ...color(['red', 'green']) },
          palette: {
            items: { description: 'One color.', ...color(['red', 'green']) },
            type: 'array',
          },
          style: {
            properties: { fill: { description: 'Fill.', ...color(['red', 'green']) } },
            type: 'object',
          },
        },
        type: 'object',
      },
      name: 'paint',
    };
    const wrapped = (enumValues: string[]) => ({
      $defs: { Color: color(enumValues) },
      properties: {
        color: { allOf: [{ $ref: '#/$defs/Color' }], description: 'Color.' },
        palette: {
          items: { allOf: [{ $ref: '#/$defs/Color' }], description: 'One color.' },
          type: 'array',
        },
        style: {
          properties: { fill: { allOf: [{ $ref: '#/$defs/Color' }], description: 'Fill.' } },
          type: 'object',
        },
      },
      type: 'object',
    });
    const diff = (inputSchema: Record<string, unknown>) =>
      compareSurface([gt], { tools: [renderedToolFromJsonSchema('paint', 'Paint.', inputSchema)] });

    expect(diff(wrapped(['red', 'green']))).toEqual([]);
    expect(diff(wrapped(['red']))).toEqual(
      ['paint.color', 'paint.palette[]', 'paint.style.fill'].map((path) => ({
        detail: 'constraint value changed: enum ["red","green"] → ["red"]',
        evidence: { keywords: ['enum'], kind: 'constraint-altered' },
        path,
        rule: 'constraint-altered',
        severity: 'info',
      })),
    );
  });

  test('the wrapper’s own keywords override its one member’s, and a changed member type is a retype', () => {
    const gt: GroundTruthTool = {
      description: 'Set.',
      inputSchema: {
        $defs: { Count: { description: 'A count.', maximum: 10, type: 'integer' } },
        properties: {
          limit: { allOf: [{ $ref: '#/$defs/Count' }], description: 'Page size.', maximum: 5 },
        },
        type: 'object',
      },
      name: 'set',
    };
    const render = (limit: Record<string, unknown>) =>
      compareSurface([gt], {
        tools: [
          renderedToolFromJsonSchema('set', 'Set.', {
            properties: { limit },
            type: 'object',
          }),
        ],
      }).map((finding) => [finding.rule, finding.evidence]);
    expect(render({ description: 'Page size.', maximum: 5, type: 'integer' })).toEqual([]);
    expect(render({ description: 'Page size.', maximum: 5, type: 'string' })).toEqual([
      ['property-retyped', { from: 'integer', kind: 'property-retyped', to: 'string' }],
    ]);
  });

  test('allOf fields past the first level and inside array items report at their paths', () => {
    const withRule = (rule: Record<string, unknown>) => ({
      $defs: { rule },
      properties: {
        config: {
          properties: {
            rules: { items: { allOf: [{ $ref: '#/$defs/rule' }] }, type: 'array' },
          },
          type: 'object',
        },
      },
      type: 'object',
    });
    const gt: GroundTruthTool = {
      description: 'Set a policy.',
      inputSchema: withRule({
        properties: {
          action: { enum: ['allow', 'deny'], type: 'string' },
          pattern: { type: 'string' },
        },
        required: ['action', 'pattern'],
        type: 'object',
      }),
      name: 'policy',
    };
    const rendered = renderedToolFromJsonSchema(
      'policy',
      'Set a policy.',
      withRule({
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
        type: 'object',
      }),
    );
    expect(compareSurface([gt], { tools: [rendered] })).toEqual([
      {
        detail: 'input property is missing from the rendered surface',
        evidence: { declaredIn: 'root', kind: 'property-missing' },
        path: 'policy.config.rules[].action',
        rule: 'property-missing',
        severity: 'fail',
      },
      {
        detail: 'required marker dropped for: action',
        evidence: { kind: 'required-dropped', names: ['action'] },
        path: 'policy.config.rules[]',
        rule: 'required-dropped',
        severity: 'fail',
      },
    ]);
  });
});

describe('whole-document $ref', () => {
  const TreeNode: z.ZodType = z.object({
    label: z.string(),
    get children() {
      return z.array(TreeNode).optional();
    },
  });
  const tree = z.toJSONSchema(TreeNode) as Record<string, unknown>;
  const groundTruth: GroundTruthTool = { description: 'Tree.', inputSchema: tree, name: 'tree' };

  function diff(inputSchema: Record<string, unknown>) {
    return compareSurface([groundTruth], {
      tools: [renderedToolFromJsonSchema('tree', 'Tree.', inputSchema)],
    });
  }

  test('a field dropped from the root-recursive element reports at the element path', () => {
    expect(tree.properties).toEqual({
      children: { items: { $ref: '#' }, type: 'array' },
      label: { type: 'string' },
    });
    const rendered = {
      additionalProperties: false,
      properties: {
        children: {
          items: {
            additionalProperties: false,
            properties: { children: { items: { $ref: '#' }, type: 'array' } },
            type: 'object',
          },
          type: 'array',
        },
        label: { type: 'string' },
      },
      required: ['label'],
      type: 'object',
    };
    expect(diff(rendered)).toEqual([
      {
        detail: 'input property is missing from the rendered surface',
        evidence: { declaredIn: 'root', kind: 'property-missing' },
        path: 'tree.children[].label',
        rule: 'property-missing',
        severity: 'fail',
      },
      {
        detail: 'required marker dropped for: label',
        evidence: { kind: 'required-dropped', names: ['label'] },
        path: 'tree.children[]',
        rule: 'required-dropped',
        severity: 'fail',
      },
    ]);
    // Control: the client rendering zod's schema verbatim diverges nowhere.
    expect(diff(tree)).toEqual([]);
  });

  test('recursion through "#" and through a self-referencing definition compare alike', () => {
    const node = {
      additionalProperties: false,
      properties: {
        children: { items: { $ref: '#/$defs/node' }, type: 'array' },
        label: { type: 'string' },
      },
      required: ['label'],
      type: 'object',
    };
    const asDefinition = (definition: Record<string, unknown>) => ({
      $defs: { node: definition },
      $ref: '#/$defs/node',
    });
    expect(diff(asDefinition(node))).toEqual([]);
    const unlabeled = { ...node, properties: { children: node.properties.children }, required: [] };
    expect(diff(asDefinition(unlabeled)).map((finding) => [finding.rule, finding.path])).toEqual([
      ['property-missing', 'tree.label'],
      ['property-missing', 'tree.children[].label'],
      ['required-dropped', 'tree.children[]'],
      ['required-dropped', 'tree'],
    ]);
  });
});

describe('closed-level exclusion', () => {
  const branchOnly = FIXTURE_TOOLS.find((tool) => tool.name === 'branch_only_fields')!;
  const groundTruth: GroundTruthTool = {
    description: branchOnly.description ?? null,
    inputSchema: branchOnly.inputSchema,
    name: branchOnly.name,
  };

  /** One `property-excluded` finding, exactly as the engine reports it. */
  const excluded = (path: string): Finding => ({
    detail:
      'input property is excluded by the rendered schema — an `additionalProperties: false` at this level does not list it, so a model following the rendered schema can never send it',
    evidence: { kind: 'property-excluded' },
    path,
    rule: 'property-excluded',
    severity: 'fail',
  });

  /** Diff ground truth against its own input schema with some root keywords replaced. */
  function diff(overrides: Record<string, unknown>, gt: GroundTruthTool = groundTruth) {
    return compareSurface([gt], {
      tools: [
        renderedToolFromJsonSchema(gt.name, gt.description, { ...gt.inputSchema, ...overrides }),
      ],
    });
  }

  test('a closed rendered root excludes each field ground truth declares only in branches', () => {
    expect(diff({ additionalProperties: false, properties: {}, type: 'object' })).toEqual([
      excluded('branch_only_fields.by_id'),
      excluded('branch_only_fields.by_name'),
    ]);
  });

  test('a field the closed level also declares in its own properties stays acceptable', () => {
    const byId = { description: 'Look up by identifier.', type: 'string' };
    expect(diff({ additionalProperties: false, properties: { by_id: byId } })).toEqual([
      excluded('branch_only_fields.by_name'),
    ]);
    expect(diff({ properties: {} })).toEqual([]);
  });

  test('ground truth that already excludes a branch field the same way is not reported', () => {
    const closed: GroundTruthTool = {
      ...groundTruth,
      inputSchema: { ...groundTruth.inputSchema, additionalProperties: false },
    };
    expect(diff({}, closed)).toEqual([]);
    const byId = { description: 'Look up by identifier.', type: 'string' };
    const partlyClosed: GroundTruthTool = {
      ...groundTruth,
      inputSchema: { ...closed.inputSchema, properties: { by_id: byId } },
    };
    expect(diff({ properties: {} }, partlyClosed)).toEqual([excluded('branch_only_fields.by_id')]);
  });

  test('a closed nested level and a closed array item report at their dotted paths', () => {
    const filter = {
      anyOf: [
        { properties: { mode: { type: 'string' } } },
        { properties: { query: { type: 'string' } } },
      ],
      type: 'object',
    };
    const closedFilter = { ...filter, additionalProperties: false, properties: {} };
    const schemaWith = (level: Record<string, unknown>) => ({
      properties: {
        filters: { items: level, type: 'array' },
        scope: { properties: { filter: level }, type: 'object' },
      },
      type: 'object',
    });
    const gt: GroundTruthTool = {
      description: 'Search.',
      inputSchema: schemaWith(filter),
      name: 'search',
    };
    const rendered = renderedToolFromJsonSchema('search', 'Search.', schemaWith(closedFilter));
    expect(
      compareSurface([gt], { tools: [rendered] }).map((finding) => [finding.rule, finding.path]),
    ).toEqual([
      ['property-excluded', 'search.filters[].mode'],
      ['property-excluded', 'search.filters[].query'],
      ['property-excluded', 'search.scope.filter.mode'],
      ['property-excluded', 'search.scope.filter.query'],
    ]);
  });

  test('allOf members count on both sides, as declarations and as closures', () => {
    const gt: GroundTruthTool = {
      description: 'Tag.',
      inputSchema: {
        allOf: [{ additionalProperties: false, properties: { tag: { type: 'string' } } }],
        anyOf: [{ properties: { note: { type: 'string' } } }],
        type: 'object',
      },
      name: 'label',
    };
    const render = (inputSchema: Record<string, unknown>) =>
      compareSurface([gt], { tools: [renderedToolFromJsonSchema('label', 'Tag.', inputSchema)] });
    // Hoisting the member's closure to the level excludes only what ground truth already did.
    expect(
      render({
        additionalProperties: false,
        anyOf: [{ properties: { note: { type: 'string' } } }],
        properties: { tag: { type: 'string' } },
        type: 'object',
      }),
    ).toEqual([]);
    // A closed level does not list a field it declares through an allOf member.
    expect(
      render({
        additionalProperties: false,
        allOf: [{ properties: { tag: { type: 'string' } } }],
        anyOf: [{ properties: { note: { type: 'string' } } }],
        type: 'object',
      }),
    ).toEqual([excluded('label.tag')]);
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

describe('structured finding evidence', () => {
  test('rendering findings carry stable facts without parsing detail text', () => {
    const missingTool = compareSurface([gtTool], { tools: [] })[0];
    expect(missingTool?.evidence).toEqual({ kind: 'tool-missing' });

    const empty = compareSurface([gtTool], renderedFrom({ type: 'object' }))[0];
    expect(empty?.evidence).toEqual({
      branchOnly: false,
      expectedPropertyCount: 2,
      kind: 'input-empty',
      scope: 'root',
    });

    const degraded = compareSurface(
      [gtTool],
      renderedFrom({
        properties: {
          message: { description: 'The message to echo.' },
        },
        type: 'object',
      }),
    );
    expect(degraded.map((finding) => finding.evidence)).toEqual([
      { groundTruthType: 'string', kind: 'property-untyped' },
      { keywords: ['maxLength', 'minLength'], kind: 'constraint-dropped' },
      { declaredIn: 'root', kind: 'property-missing' },
      { kind: 'required-dropped', names: ['message'] },
    ]);
  });

  test('output divergence variants remain distinct at a shared rule', () => {
    const groundTruth: GroundTruthTool = {
      description: 'Return a result.',
      inputSchema: { type: 'object' },
      name: 'result',
      outputSchema: {
        properties: {
          count: { type: 'integer' },
          meta: { properties: { ok: { type: 'boolean' } }, type: 'object' },
          name: { type: 'string' },
        },
        type: 'object',
      },
    };
    const rendered = renderedToolFromJsonSchema('result', 'Return a result.', { type: 'object' });
    rendered.outputProperties = renderedPropertiesFromJsonSchema({
      properties: {
        count: {},
        meta: { type: 'object' },
      },
      type: 'object',
    });
    expect(
      compareSurface([groundTruth], { tools: [rendered] }).map((finding) => finding.evidence),
    ).toEqual([
      { groundTruthType: 'integer', kind: 'output-field-untyped' },
      { expectedPropertyCount: 1, kind: 'output-nested-empty' },
      { kind: 'output-field-missing' },
    ]);
  });

  test('runtime findings have evidence but remain separate from rendering facts', () => {
    const base = {
      adapter: 'mcpo',
      canary: null,
      durationMs: 1,
      resolvedVersion: '0.0.20',
      statusDetail: 'failed',
      surface: null,
    } as const;
    expect(buildFindings([], { ...base, status: 'adapter-broken' })[0]?.evidence).toEqual({
      kind: 'adapter-broken',
    });
    expect(buildFindings([], { ...base, status: 'handshake-failure' })[0]?.evidence).toEqual({
      kind: 'handshake-failure',
    });
  });
});

describe('depthLimitedPaths', () => {
  type Schema = Record<string, unknown>;
  /** `levels` nested objects, each holding the next under `next`, ending in `leaf`. */
  const chain = (levels: number, leaf: Schema): Schema =>
    levels === 0 ? leaf : { properties: { next: chain(levels - 1, leaf) }, type: 'object' };
  const object = (properties: Record<string, Schema>): Schema => ({ properties, type: 'object' });
  const tool = (name: string, inputSchema: Schema, outputSchema?: Schema): GroundTruthTool => ({
    description: 'D.',
    inputSchema,
    name,
    ...(outputSchema === undefined ? {} : { outputSchema }),
  });

  test('names the node where comparison stopped short, while the diff below it stays silent', () => {
    const leaf = { description: 'leaf', maximum: 5, type: 'integer' };
    const groundTruth = [tool('deep', object({ a: chain(7, leaf) }))];
    const rendered = renderedToolFromJsonSchema(
      'deep',
      'D.',
      object({ a: chain(7, { type: 'object' }) }),
    );
    expect(compareSurface(groundTruth, { tools: [rendered] })).toEqual([]);
    expect(depthLimitedPaths(groundTruth)).toEqual(['deep.a.next.next.next.next.next.next']);
  });

  test('uses finding path syntax for array elements and output schemas, sorted by code unit', () => {
    const elementAtCap = chain(5, { items: object({ x: { type: 'string' } }), type: 'array' });
    const groundTruth = [
      tool(
        'b',
        object({ z: chain(7, { type: 'string' }), a: elementAtCap }),
        object({ out: chain(7, { type: 'string' }) }),
      ),
      tool('a', object({ scalar: chain(6, { type: 'string' }) })),
    ];
    expect(depthLimitedPaths(groundTruth)).toEqual([
      'b.a.next.next.next.next.next[]',
      'b.z.next.next.next.next.next.next',
      'output:b.out.next.next.next.next.next.next',
    ]);
  });

  test('lists a path once when a tool is advertised twice', () => {
    const deep = tool('deep', object({ a: chain(7, { type: 'string' }) }));
    expect(depthLimitedPaths([deep, deep])).toEqual(['deep.a.next.next.next.next.next.next']);
  });

  test('recursion the visited set stops lists nothing; a seven-schema cycle lists one stable path', () => {
    const ring = (length: number): Schema => ({
      $defs: Object.fromEntries(
        Array.from({ length }, (_, index) => [
          `n${index}`,
          object({ next: { $ref: `#/$defs/n${(index + 1) % length}` } }),
        ]),
      ),
      properties: { start: { $ref: '#/$defs/n0' } },
      type: 'object',
    });
    const node = object({ child: { $ref: '#/$defs/node' } });
    const tree = object({ kids: { items: { $ref: '#/$defs/tree' }, type: 'array' } });
    const recursive = [
      tool('self', { $defs: { node }, properties: { root: { $ref: '#/$defs/node' } } }),
      tool('items', { $defs: { tree }, properties: { root: { $ref: '#/$defs/tree' } } }),
      tool('mutual', ring(2)),
      tool('whole', object({ self: { $ref: '#' } }), object({ self: { $ref: '#' } })),
    ];
    expect(depthLimitedPaths(recursive)).toEqual([]);
    const cycle = [tool('loop', ring(7))];
    const expected = ['loop.start.next.next.next.next.next.next'];
    expect(depthLimitedPaths(cycle)).toEqual(expected);
    expect(depthLimitedPaths(cycle)).toEqual(expected);
  });

  test('the bundled fixture and a captured SDK v1 surface list nothing', () => {
    expect(depthLimitedPaths(FIXTURE_GROUND_TRUTH)).toEqual([]);
    expect(depthLimitedPaths(SDK_V1_GROUND_TRUTH.tools)).toEqual([]);
  });
});

describe('groundTruthFindings', () => {
  const tool = (inputSchema: Record<string, unknown>, outputSchema?: Record<string, unknown>) => ({
    description: 'D.',
    inputSchema: { type: 'object', ...inputSchema },
    name: 'legacy',
    ...(outputSchema === undefined ? {} : { outputSchema: { type: 'object', ...outputSchema } }),
  });
  const DRAFT_04 = 'http://json-schema.org/draft-04/schema#';

  test('an unrecognized dialect on outputSchema or inputSchema yields one info note at its path', () => {
    const output = groundTruthFindings([tool({}, { $schema: DRAFT_04 })]);
    expect(output).toEqual([
      {
        detail: expect.stringContaining('TypeScript SDK v2 clients reject every call to this tool'),
        evidence: { declared: DRAFT_04, kind: 'unsupported-dialect' },
        path: 'output:legacy',
        rule: 'unsupported-dialect',
        severity: 'info',
      },
    ]);
    const input = groundTruthFindings([tool({ $schema: DRAFT_04 })]);
    expect(input.map((finding) => [finding.path, finding.evidence, finding.severity])).toEqual([
      ['legacy', { declared: DRAFT_04, kind: 'unsupported-dialect' }, 'info'],
    ]);
    expect(input[0]?.detail).not.toContain('reject every call');
  });

  test('reports any dialect outside the recognized set, matched exactly and case-sensitively', () => {
    const reported = [
      'https://example.com/custom-dialect',
      'https://json-schema.org/draft-04/schema',
      'https://json-schema.org/draft/2020-12/schema##',
      'HTTPS://json-schema.org/draft/2020-12/schema',
      'https://JSON-schema.org/draft-07/schema',
      'https://json-schema.org/draft/2020-12/schema ',
      '',
    ];
    for (const declared of reported) {
      expect(
        groundTruthFindings([tool({ $schema: declared }, { $schema: declared })]).map((finding) => [
          finding.path,
          finding.evidence,
        ]),
      ).toEqual([
        ['legacy', { declared, kind: 'unsupported-dialect' }],
        ['output:legacy', { declared, kind: 'unsupported-dialect' }],
      ]);
    }
  });

  test('the four recognized dialects in http or https, with or without a trailing #, are silent', () => {
    const dialects = [
      'draft/2020-12/schema',
      'draft/2019-09/schema',
      'draft-07/schema',
      'draft-06/schema',
    ];
    const accepted = dialects.flatMap((dialect) =>
      ['http', 'https'].flatMap((scheme) => [
        `${scheme}://json-schema.org/${dialect}`,
        `${scheme}://json-schema.org/${dialect}#`,
      ]),
    );
    expect(accepted).toHaveLength(16);
    expect(
      groundTruthFindings(
        accepted.map((declared) => tool({ $schema: declared }, { $schema: declared })),
      ),
    ).toEqual([]);
  });

  test('an absent, non-string, or nested $schema is silent', () => {
    const nested = { properties: { x: { $schema: DRAFT_04, type: 'string' } } };
    expect(
      groundTruthFindings([
        tool({}),
        tool({}, {}),
        tool({ $schema: 7 }, { $schema: { $ref: DRAFT_04 } }),
        tool({ $schema: null }, { $schema: [DRAFT_04] }),
        tool(nested, nested),
        tool({ $defs: { X: { $schema: DRAFT_04 } } }),
      ]),
    ).toEqual([]);
  });

  test('SDK v1 McpServer output (draft-07 on both schemas) and the bundled fixture are silent', () => {
    const draft07 = 'http://json-schema.org/draft-07/schema#';
    const withOutput = SDK_V1_GROUND_TRUTH.tools.map((sdkTool) => ({
      ...sdkTool,
      outputSchema: { $schema: draft07, properties: { ok: { type: 'boolean' } }, type: 'object' },
    }));
    expect(withOutput.every((sdkTool) => sdkTool.inputSchema.$schema === draft07)).toBe(true);
    expect(groundTruthFindings(withOutput)).toEqual([]);
    expect(groundTruthFindings(FIXTURE_GROUND_TRUTH)).toEqual([]);
  });

  test('notes follow tool order, input before output', () => {
    const custom = 'https://example.com/custom-dialect';
    const second = { ...tool({ $schema: custom }), name: 'second' };
    expect(
      groundTruthFindings([tool({ $schema: DRAFT_04 }, { $schema: custom }), second]).map(
        (finding) => finding.path,
      ),
    ).toEqual(['legacy', 'output:legacy', 'second']);
  });

  test('a tool SDK v1 rejects yields one sdk-v1-rejected note naming every rejected location, ahead of its dialect notes', () => {
    const findings = groundTruthFindings([
      {
        ...tool({ $schema: DRAFT_04 }),
        sdkV1Rejection: [
          'description: Invalid input: expected string, received number',
          'inputSchema.properties.payload: Invalid input',
        ],
      },
      { ...tool({}), name: 'second', sdkV1Rejection: ['outputSchema.type: Invalid input'] },
    ]);
    expect(
      findings.map((finding) => [finding.rule, finding.path, finding.evidence, finding.severity]),
    ).toEqual([
      ['sdk-v1-rejected', 'legacy', { kind: 'sdk-v1-rejected' }, 'info'],
      [
        'unsupported-dialect',
        'legacy',
        { declared: DRAFT_04, kind: 'unsupported-dialect' },
        'info',
      ],
      ['sdk-v1-rejected', 'second', { kind: 'sdk-v1-rejected' }, 'info'],
    ]);
    expect(findings[0]?.detail).toContain('@modelcontextprotocol/sdk 1.x');
    expect(findings[0]?.detail).toContain('the whole tools/list result');
    expect(findings[0]?.detail).toContain('description: Invalid input: expected string');
    expect(findings[0]?.detail).toContain('inputSchema.properties.payload: Invalid input');
  });

  test('a tool without a recorded SDK v1 rejection, or with an empty one, gets no note', () => {
    expect(groundTruthFindings([tool({}), { ...tool({}), sdkV1Rejection: [] }])).toEqual([]);
  });
});
