/**
 * @file src/invariants.test.ts
 * Unit tests for the invariant engine: every rule exercised with hand-built
 * ground-truth/rendered pairs, plus run-level finding assembly.
 */
import { describe, expect, test } from 'bun:test';

import { buildFindings, compareSurface } from './invariants.js';
import { renderedPropertiesFromJsonSchema, renderedToolFromJsonSchema } from './schema.js';
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
    const findings = diff(withTransport(faithfulTimeout, ['timeoutMs'])).filter((finding) =>
      finding.path?.includes('tags'),
    );
    expect(findings).toEqual([]);
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
