/**
 * @file src/schema.test.ts
 * Unit tests for JSON Schema normalization: effective types, $ref resolution,
 * and constraint extraction.
 */
import { describe, expect, test } from 'bun:test';

import { effectiveType, renderedToolFromJsonSchema, resolveRef } from './schema.js';

describe('effectiveType', () => {
  test('explicit string type', () => {
    expect(effectiveType({ type: 'string' }, {})).toBe('string');
  });

  test('type arrays join deterministically', () => {
    expect(effectiveType({ type: ['string', 'null'] }, {})).toBe('null|string');
  });

  test('enum without type still yields type information', () => {
    expect(effectiveType({ enum: ['a', 'b'] }, {})).toBe('enum<string>');
  });

  test('const without type still yields type information', () => {
    expect(effectiveType({ const: 5 }, {})).toBe('const<number>');
  });

  test('anyOf branches contribute type information', () => {
    expect(effectiveType({ anyOf: [{ type: 'string' }, { type: 'number' }] }, {})).toBe(
      'anyOf<number|string>',
    );
  });

  test('no type information at all yields null', () => {
    expect(effectiveType({ description: 'mystery' }, {})).toBeNull();
  });
});

describe('resolveRef', () => {
  const doc = {
    components: { schemas: { thing: { properties: { x: { type: 'number' } }, type: 'object' } } },
  };

  test('resolves a local pointer', () => {
    expect(resolveRef({ $ref: '#/components/schemas/thing' }, doc)).toEqual(
      doc.components.schemas.thing,
    );
  });

  test('returns non-ref schemas unchanged', () => {
    expect(resolveRef({ type: 'string' }, doc)).toEqual({ type: 'string' });
  });

  test('unresolvable pointer yields null', () => {
    expect(resolveRef({ $ref: '#/components/schemas/missing' }, doc)).toBeNull();
  });

  test('cyclic refs terminate', () => {
    const cyclic: Record<string, unknown> = { a: { $ref: '#/b' }, b: { $ref: '#/a' } };
    expect(resolveRef({ $ref: '#/a' }, cyclic)).toBeNull();
  });
});

describe('renderedToolFromJsonSchema', () => {
  test('normalizes properties, required, descriptions, and constraints', () => {
    const tool = renderedToolFromJsonSchema('echo', 'Echo.', {
      properties: {
        message: { description: 'The message.', maxLength: 10, type: 'string' },
      },
      required: ['message'],
      type: 'object',
    });
    expect(tool.name).toBe('echo');
    expect(tool.requiredNames).toEqual(['message']);
    const message = tool.properties[0];
    expect(message?.type).toBe('string');
    expect(message?.description).toBe('The message.');
    expect(message?.required).toBe(true);
    expect(message?.requiredNames).toEqual([]);
    expect(message?.explicitType).toBe('string');
    expect(message?.constraints).toEqual({ maxLength: 10 });
  });

  test('normalizes explicit type arrays without coercion', () => {
    const tool = renderedToolFromJsonSchema('types', null, {
      properties: {
        malformed: { type: ['string', 7] },
        nullable: { type: ['string', 'null'] },
      },
      type: 'object',
    });

    expect(tool.properties[0]?.explicitType).toBeNull();
    expect(tool.properties[1]?.explicitType).toBe('null|string');
  });

  test('resolves $ref properties against an enclosing document', () => {
    const doc = {
      components: {
        schemas: {
          echo_form: {
            properties: { message: { $ref: '#/components/schemas/msg' } },
            required: ['message'],
            type: 'object',
          },
          msg: { description: 'Refd.', type: 'string' },
        },
      },
    };
    const tool = renderedToolFromJsonSchema(
      'echo',
      null,
      { $ref: '#/components/schemas/echo_form' },
      doc,
    );
    expect(tool.properties[0]?.type).toBe('string');
    expect(tool.properties[0]?.description).toBe('Refd.');
    expect(tool.requiredNames).toEqual(['message']);
  });

  test('root anyOf is detected', () => {
    const tool = renderedToolFromJsonSchema('multi', null, {
      anyOf: [{ required: ['a'] }],
      properties: { a: { type: 'string' } },
      type: 'object',
    });
    expect(tool.hasRootUnion).toBe(true);
  });

  test('scalar properties carry no nested fields', () => {
    const tool = renderedToolFromJsonSchema('echo', null, {
      properties: { message: { type: 'string' } },
      type: 'object',
    });
    expect(tool.properties[0]?.children).toBeUndefined();
    expect(tool.properties[0]?.items).toBeUndefined();
  });
});

describe('nested normalization', () => {
  const NESTED = {
    properties: {
      config: {
        description: 'Connection configuration.',
        properties: {
          tags: {
            items: { properties: { name: { type: 'string' } }, type: 'object' },
            maxItems: 5,
            type: 'array',
          },
          transport: {
            properties: { timeoutMs: { description: 'Per-request timeout.', minimum: 1 } },
            required: ['timeoutMs'],
            type: 'object',
          },
        },
        required: ['transport'],
        type: 'object',
      },
    },
    required: ['config'],
    type: 'object',
  };

  const tool = renderedToolFromJsonSchema('connect', null, NESTED);
  const config = tool.properties[0];
  const transport = config?.children?.find((child) => child.name === 'transport');
  const tags = config?.children?.find((child) => child.name === 'tags');

  test('object properties carry their sub-properties as children', () => {
    expect(config?.name).toBe('config');
    expect(config?.children?.map((child) => child.name)).toEqual(['tags', 'transport']);
    expect(transport?.children?.map((child) => child.name)).toEqual(['timeoutMs']);
  });

  test('required is scoped to the level that declares it', () => {
    expect(tool.requiredNames).toEqual(['config']);
    expect(transport?.required).toBe(true);
    expect(tags?.required).toBe(false);
    expect(transport?.children?.[0]?.required).toBe(true);
    expect(config?.requiredNames).toEqual(['transport']);
    expect(transport?.requiredNames).toEqual(['timeoutMs']);
  });

  test('nested raw required names include names the object does not declare', () => {
    const nested = renderedToolFromJsonSchema('configure', null, {
      properties: {
        config: {
          properties: { retries: { type: 'integer' } },
          required: ['retries', 'timeoutMs'],
          type: 'object',
        },
      },
      type: 'object',
    });

    expect(nested.properties[0]?.requiredNames).toEqual(['retries', 'timeoutMs']);
  });

  test('nested descriptions and constraints are extracted at every level', () => {
    const timeoutMs = transport?.children?.[0];
    expect(timeoutMs?.description).toBe('Per-request timeout.');
    expect(timeoutMs?.constraints).toEqual({ minimum: 1 });
    expect(tags?.constraints).toEqual({ maxItems: 5 });
  });

  test('array element schemas normalize as an item node', () => {
    expect(tags?.items?.type).toBe('object');
    expect(tags?.items?.children?.map((child) => child.name)).toEqual(['name']);
  });

  test('object-valued array items retain their own raw required names', () => {
    const array = renderedToolFromJsonSchema('tag', null, {
      properties: {
        tags: {
          items: {
            properties: { name: { type: 'string' } },
            required: ['name', 'color'],
            type: 'object',
          },
          type: 'array',
        },
      },
      type: 'object',
    });

    expect(array.properties[0]?.items?.requiredNames).toEqual(['name', 'color']);
  });

  test('tuple-form items are not descended into', () => {
    const tuple = renderedToolFromJsonSchema('tuple', null, {
      properties: { pair: { items: [{ type: 'string' }, { type: 'number' }], type: 'array' } },
      type: 'object',
    });
    expect(tuple.properties[0]?.items).toBeUndefined();
  });

  test('keywords declared alongside a $ref layer over its target', () => {
    const doc = {
      $defs: { model: { properties: { inner: { type: 'string' } }, type: 'object' } },
      properties: {
        config: { $ref: '#/$defs/model', description: 'Declared at the reference site.' },
      },
      type: 'object',
    };
    const tool = renderedToolFromJsonSchema('connect', null, doc);
    expect(tool.properties[0]?.description).toBe('Declared at the reference site.');
    expect(tool.properties[0]?.type).toBe('object');
    expect(tool.properties[0]?.children?.map((child) => child.name)).toEqual(['inner']);
  });

  test('$refs resolve at every level, not just the root', () => {
    const doc = {
      $defs: {
        transport: {
          properties: { timeoutMs: { description: 'Refd timeout.', type: 'integer' } },
          required: ['timeoutMs', 'endpoint'],
          type: 'object',
        },
      },
      properties: {
        config: { properties: { transport: { $ref: '#/$defs/transport' } }, type: 'object' },
      },
      type: 'object',
    };
    const refd = renderedToolFromJsonSchema('connect', null, doc);
    const nested = refd.properties[0]?.children?.[0];
    expect(nested?.type).toBe('object');
    expect(nested?.children?.[0]?.description).toBe('Refd timeout.');
    expect(nested?.requiredNames).toEqual(['timeoutMs', 'endpoint']);
  });
});

describe('walk termination', () => {
  test('a schema that recurses through properties terminates', () => {
    const recursive = {
      $defs: {
        node: {
          properties: { child: { $ref: '#/$defs/node' }, label: { type: 'string' } },
          type: 'object',
        },
      },
      properties: { root: { $ref: '#/$defs/node' } },
      type: 'object',
    };
    const tool = renderedToolFromJsonSchema('tree', null, recursive);
    const root = tool.properties[0];
    expect(root?.children?.map((child) => child.name)).toEqual(['child', 'label']);
    const child = root?.children?.find((candidate) => candidate.name === 'child');
    expect(child?.type).toBe('object');
    // The visited set stops the walk where the schema loops back on itself.
    expect(child?.children).toBeUndefined();
  });

  test('mutually recursive $defs terminate', () => {
    const mutual = {
      $defs: {
        a: { properties: { toB: { $ref: '#/$defs/b' } }, type: 'object' },
        b: { properties: { toA: { $ref: '#/$defs/a' } }, type: 'object' },
      },
      properties: { start: { $ref: '#/$defs/a' } },
      type: 'object',
    };
    const tool = renderedToolFromJsonSchema('loop', null, mutual);
    const toB = tool.properties[0]?.children?.[0];
    const toA = toB?.children?.[0];
    expect(toB?.name).toBe('toB');
    expect(toA?.name).toBe('toA');
    expect(toA?.children).toBeUndefined();
  });

  test('the depth cap bounds a schema that nests without refs', () => {
    const nest = (depth: number): Record<string, unknown> =>
      depth === 0 ? { type: 'string' } : { properties: { down: nest(depth - 1) }, type: 'object' };
    const tool = renderedToolFromJsonSchema('deep', null, nest(12));
    let node = tool.properties[0];
    let levels = 0;
    while (node?.children !== undefined) {
      node = node.children[0];
      levels += 1;
    }
    expect(levels).toBe(6);
  });
});

describe('union branch collection', () => {
  const BRANCH_ONLY = {
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
  };

  test('fields declared only inside branches are collected and marked', () => {
    const tool = renderedToolFromJsonSchema('lookup', null, BRANCH_ONLY);
    expect(tool.properties.map((property) => property.name)).toEqual(['by_id', 'by_name']);
    expect(tool.properties.map((property) => property.declaredIn)).toEqual(['branch', 'branch']);
    expect(tool.properties[0]?.type).toBe('string');
    expect(tool.properties[0]?.description).toBe('By identifier.');
  });

  test('branch required arrays never merge into the level that owns them', () => {
    const tool = renderedToolFromJsonSchema('lookup', null, BRANCH_ONLY);
    expect(tool.requiredNames).toEqual([]);
    expect(tool.properties.some((property) => property.required)).toBe(false);
  });

  test('a name declared at the level itself wins over the same name in a branch', () => {
    const tool = renderedToolFromJsonSchema('mixed', null, {
      oneOf: [{ properties: { a: { type: 'number' } } }, { properties: { c: { type: 'string' } } }],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
      type: 'object',
    });
    expect(tool.properties.map((property) => property.name)).toEqual(['a', 'b', 'c']);
    expect(tool.properties[0]?.type).toBe('string');
    expect(tool.properties[0]?.declaredIn).toBe('root');
    expect(tool.properties[0]?.required).toBe(true);
    expect(tool.properties[2]?.declaredIn).toBe('branch');
  });

  test('ref-bearing branches resolve before collection', () => {
    const doc = {
      components: {
        schemas: { by_id: { properties: { id: { type: 'string' } }, required: ['id'] } },
      },
      paths: {},
    };
    const tool = renderedToolFromJsonSchema(
      'lookup',
      null,
      { anyOf: [{ $ref: '#/components/schemas/by_id' }], type: 'object' },
      doc,
    );
    expect(tool.properties.map((property) => property.name)).toEqual(['id']);
    expect(tool.properties[0]?.declaredIn).toBe('branch');
    expect(tool.requiredNames).toEqual([]);
  });

  test('branch collection applies below the root too', () => {
    const tool = renderedToolFromJsonSchema('nested', null, {
      properties: {
        filter: {
          anyOf: [
            {
              properties: { since: { type: 'string' } },
              required: ['since', 'branchOnly'],
            },
          ],
          required: ['since', 'containerOnly'],
          type: 'object',
        },
      },
      type: 'object',
    });
    const filter = tool.properties[0];
    const since = filter?.children?.[0];
    expect(since?.name).toBe('since');
    expect(since?.declaredIn).toBe('branch');
    expect(since?.required).toBe(true);
    expect(filter?.requiredNames).toEqual(['since', 'containerOnly']);
  });
});
