/**
 * @file src/schema.test.ts
 * Unit tests for JSON Schema normalization: effective types, $ref resolution,
 * and constraint extraction.
 */
import { describe, expect, test } from 'bun:test';

import { effectiveType, renderedToolFromJsonSchema, resolveRef } from './schema.js';
import type { RenderedProperty } from './types.js';

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

  test('a union that refers back to itself takes its type from the other branches', () => {
    const doc = { $defs: { A: { anyOf: [{ $ref: '#/$defs/A' }, { type: 'string' }] } } };
    expect(effectiveType(doc.$defs.A, doc)).toBe('anyOf<string>');
    const root = { anyOf: [{ $ref: '#' }, { type: 'number' }] };
    expect(effectiveType(root, root)).toBe('anyOf<number>');
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

  test('a segment naming an inherited property is dangling, like a missing key', () => {
    for (const ref of [
      '#/__proto__',
      '#/constructor',
      '#/components/__proto__',
      '#/components/schemas/toString',
    ]) {
      expect(resolveRef({ $ref: ref }, doc)).toBeNull();
    }
  });

  test('an own key spelled like an inherited one still resolves', () => {
    const own = JSON.parse('{"__proto__": {"type": "string"}}') as unknown;
    expect(resolveRef({ $ref: '#/__proto__' }, own)).toEqual({ type: 'string' });
  });

  test('cyclic refs terminate', () => {
    const cyclic: Record<string, unknown> = { a: { $ref: '#/b' }, b: { $ref: '#/a' } };
    expect(resolveRef({ $ref: '#/a' }, cyclic)).toBeNull();
  });

  test('a whole-document "#" resolves to the document itself', () => {
    const tree = {
      properties: { children: { items: { $ref: '#' }, type: 'array' } },
      type: 'object',
    };
    expect(resolveRef({ $ref: '#' }, tree)).toBe(tree);
  });

  test('a document whose root is itself "#" is cyclic and unresolvable', () => {
    const selfReference = { $ref: '#' };
    expect(resolveRef(selfReference, selfReference)).toBeNull();
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

  test('a boolean property schema normalizes as an untyped property with no keywords', () => {
    const tool = renderedToolFromJsonSchema('any', null, {
      properties: {
        nested: { properties: { inner: true }, type: 'object' },
        off: false,
        payload: true,
      },
      required: ['payload'],
      type: 'object',
    });
    const untyped = (name: string, required: boolean): RenderedProperty => ({
      constraints: {},
      declaredIn: 'root',
      description: null,
      excluded: false,
      explicitType: null,
      name,
      required,
      requiredNames: [],
      type: null,
    });
    expect(tool.properties).toEqual([
      {
        ...untyped('nested', false),
        children: [untyped('inner', false)],
        explicitType: 'object',
        type: 'object',
      },
      untyped('off', false),
      untyped('payload', true),
    ]);
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

  test('a whole-document $ref models a root-recursive element as the root object, once', () => {
    // zod 4.6.5 `z.toJSONSchema` of a self-recursive `z.object`.
    const tree = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: {
        children: { items: { $ref: '#' }, type: 'array' },
        label: { type: 'string' },
      },
      required: ['label'],
      type: 'object',
    };
    const tool = renderedToolFromJsonSchema('tree', null, tree);
    const element = tool.properties.find((property) => property.name === 'children')?.items;
    expect(element?.type).toBe('object');
    expect(element?.requiredNames).toEqual(['label']);
    expect(element?.children?.map((child) => child.name)).toEqual(['children', 'label']);
    // The element's own `children` array loops back to a schema already on the path.
    const inner = element?.children?.find((child) => child.name === 'children');
    expect(inner?.type).toBe('array');
    expect(inner?.items).toBeUndefined();
  });

  test('a document that refers to itself below the root terminates', () => {
    const tool = renderedToolFromJsonSchema('self', null, {
      properties: { self: { $ref: '#' } },
      type: 'object',
    });
    const self = tool.properties[0];
    expect(self?.type).toBe('object');
    expect(self?.children?.map((child) => child.name)).toEqual(['self']);
    expect(self?.children?.[0]?.children).toBeUndefined();
  });

  test('a tool whose root is a $ref to a self-referencing definition expands the recursion once', () => {
    const doc = {
      $defs: {
        node: {
          properties: { child: { $ref: '#/$defs/node' }, label: { type: 'string' } },
          type: 'object',
        },
      },
      $ref: '#/$defs/node',
    };
    const tool = renderedToolFromJsonSchema('tree', null, doc);
    const child = tool.properties.find((property) => property.name === 'child');
    expect(child?.children?.map((grandchild) => grandchild.name)).toEqual(['child', 'label']);
    expect(child?.children?.find((grandchild) => grandchild.name === 'child')?.children).toBe(
      undefined,
    );
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

describe('depth-limit marker', () => {
  type Schema = Record<string, unknown>;
  /** `levels` nested objects, each holding the next under `next`, ending in `leaf`. */
  const chain = (levels: number, leaf: Schema): Schema =>
    levels === 0 ? leaf : { properties: { next: chain(levels - 1, leaf) }, type: 'object' };
  /** A tool whose property `a` (depth 0) opens a chain that puts `leaf` at depth 6, the cap. */
  const atCap = (leaf: Schema, root: Schema = {}) =>
    renderedToolFromJsonSchema('deep', null, {
      ...root,
      properties: { a: chain(6, leaf) },
      type: 'object',
    });
  /** Names of every marked node in a normalized tree. */
  const markedNames = (properties: RenderedProperty[] = []): string[] =>
    properties.flatMap((property) => [
      ...(property.depthLimited === true ? [property.name] : []),
      ...markedNames(property.children),
      ...markedNames(property.items === undefined ? [] : [property.items]),
    ]);
  /** `length` `$defs` entries in a ring, each pointing at the next, entered at `n0`. */
  const ring = (length: number) => ({
    $defs: Object.fromEntries(
      Array.from({ length }, (_, index) => [
        `n${index}`,
        { properties: { next: { $ref: `#/$defs/n${(index + 1) % length}` } }, type: 'object' },
      ]),
    ),
    properties: { start: { $ref: '#/$defs/n0' } },
    type: 'object',
  });

  test('a property the cap cuts off from its fields is marked and walked no further', () => {
    const tool = atCap(chain(1, { type: 'integer' }));
    let cut = tool.properties[0];
    for (let level = 0; level < 6; level++) cut = cut?.children?.[0];
    expect(cut?.name).toBe('next');
    expect(cut?.type).toBe('object');
    expect(cut?.depthLimited).toBe(true);
    expect(cut?.children).toBeUndefined();
    expect(markedNames(tool.properties)).toEqual(['next']);
  });

  test('a scalar leaf at the cap is not marked', () => {
    const tool = atCap({ description: 'leaf', maximum: 5, type: 'integer' });
    let leaf = tool.properties[0];
    for (let level = 0; level < 6; level++) leaf = leaf?.children?.[0];
    expect(leaf?.type).toBe('integer');
    expect(markedNames(tool.properties)).toEqual([]);
  });

  test('an array, a branch-only object, or an allOf member with fields at the cap is marked', () => {
    const X = { properties: { x: { type: 'string' } } };
    const cases: [Schema, Schema?][] = [
      [{ items: { type: 'string' }, type: 'array' }],
      [{ items: {}, type: 'array' }],
      [{ anyOf: [X, { type: 'null' }], type: 'object' }],
      [{ oneOf: [{ $ref: '#/$defs/X' }] }, { $defs: { X } }],
      [{ allOf: [X] }],
    ];
    for (const [leaf, root] of cases) {
      expect(markedNames(atCap(leaf, root).properties)).toEqual(['next']);
    }
  });

  test('a schema at the cap that declares nothing below it is not marked', () => {
    const cases: Schema[] = [
      { type: 'array' },
      { type: 'object' },
      { properties: {}, type: 'object' },
      { anyOf: [{ type: 'string' }, { type: 'null' }] },
      { items: [{ type: 'string' }], type: 'array' },
      { $ref: '#/$defs/missing' },
    ];
    for (const leaf of cases) {
      expect(markedNames(atCap(leaf).properties)).toEqual([]);
    }
  });

  test('a loop back to a schema already on the path is never marked', () => {
    const node = {
      properties: { child: { $ref: '#/$defs/node' }, label: { type: 'string' } },
      type: 'object',
    };
    const tree = {
      properties: { children: { items: { $ref: '#/$defs/tree' }, type: 'array' } },
      type: 'object',
    };
    const recursive: Schema[] = [
      { $defs: { node }, properties: { root: { $ref: '#/$defs/node' } }, type: 'object' },
      { $defs: { tree }, properties: { root: { $ref: '#/$defs/tree' } }, type: 'object' },
      { properties: { self: { $ref: '#' } }, type: 'object' },
      ring(2),
      // Six nodes in a ring put the loop back to `n0` exactly at the cap.
      ring(6),
    ];
    for (const schema of recursive) {
      expect(markedNames(renderedToolFromJsonSchema('loop', null, schema).properties)).toEqual([]);
    }
  });

  test('a ring longer than the cap is marked once, where the cap lands', () => {
    const tool = renderedToolFromJsonSchema('loop', null, ring(7));
    expect(markedNames(tool.properties)).toEqual(['next']);
    let cut = tool.properties[0];
    for (let level = 0; level < 6; level++) cut = cut?.children?.[0];
    expect(cut?.depthLimited).toBe(true);
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

describe('allOf composition', () => {
  test('allOf members contribute unconditional properties and required names', () => {
    const tool = renderedToolFromJsonSchema('create_ticket', null, {
      allOf: [
        { properties: { title: { type: 'string' } }, required: ['title'] },
        { properties: { priority: { type: 'integer' } }, required: ['priority'] },
      ],
      properties: { title: { description: 'Declared at the level.', type: 'string' } },
      required: ['title'],
      type: 'object',
    });
    expect(
      tool.properties.map((property) => [property.name, property.declaredIn, property.required]),
    ).toEqual([
      ['title', 'root', true],
      ['priority', 'root', true],
    ]);
    expect(tool.properties[0]?.description).toBe('Declared at the level.');
    expect(tool.requiredNames).toEqual(['title', 'priority']);
    expect(tool.hasRootUnion).toBe(false);
  });

  test('a described $ref wrapped in allOf carries its target’s fields', () => {
    const doc = {
      $defs: {
        config: {
          properties: { retries: { type: 'integer' } },
          required: ['retries', 'timeoutMs'],
          type: 'object',
        },
      },
      properties: { config: { allOf: [{ $ref: '#/$defs/config' }], description: 'Settings.' } },
      type: 'object',
    };
    const config = renderedToolFromJsonSchema('connect', null, doc).properties[0];
    expect(config?.description).toBe('Settings.');
    expect(config?.type).toBe('object');
    expect(config?.explicitType).toBe('object');
    expect(config?.children?.map((child) => [child.name, child.required])).toEqual([
      ['retries', true],
    ]);
    expect(config?.requiredNames).toEqual(['retries', 'timeoutMs']);
  });

  test('a one-member allOf supplies its member’s values under the wrapper’s own; more members supply none', () => {
    const doc = {
      $defs: {
        Tags: {
          description: 'Tags.',
          items: { maxLength: 8, type: 'string' },
          maxItems: 3,
          type: 'array',
        },
      },
      properties: {
        many: { allOf: [{ $ref: '#/$defs/Tags' }, { minItems: 1 }], description: 'Labels.' },
        one: { allOf: [{ $ref: '#/$defs/Tags' }], description: 'Labels.', maxItems: 2 },
      },
      type: 'object',
    };
    const [many, one] = renderedToolFromJsonSchema('tag', null, doc).properties;
    expect([one?.description, one?.explicitType, one?.type, one?.constraints]).toEqual([
      'Labels.',
      'array',
      'array',
      { maxItems: 2 },
    ]);
    expect(one?.items?.constraints).toEqual({ maxLength: 8 });
    expect([many?.description, many?.explicitType, many?.type, many?.constraints]).toEqual([
      'Labels.',
      null,
      'allOf<array>',
      {},
    ]);
    expect(many?.items).toBeUndefined();
  });

  test('members nest, and a member’s own union branches stay conditional', () => {
    const tool = renderedToolFromJsonSchema('nest', null, {
      allOf: [
        { allOf: [{ properties: { deep: { type: 'string' } }, required: ['deep'] }] },
        { anyOf: [{ properties: { maybe: { type: 'string' } }, required: ['maybe'] }] },
      ],
      type: 'object',
    });
    expect(
      tool.properties.map((property) => [property.name, property.declaredIn, property.required]),
    ).toEqual([
      ['deep', 'root', true],
      ['maybe', 'branch', false],
    ]);
    expect(tool.requiredNames).toEqual(['deep']);
  });

  test('allOf applies at nested and array-item levels', () => {
    const tool = renderedToolFromJsonSchema('store', null, {
      properties: {
        records: {
          items: { allOf: [{ properties: { id: { type: 'string' } }, required: ['id'] }] },
          type: 'array',
        },
      },
      type: 'object',
    });
    const record = tool.properties[0]?.items;
    expect(record?.children?.map((child) => [child.name, child.required])).toEqual([['id', true]]);
    expect(record?.requiredNames).toEqual(['id']);
  });

  test('an allOf cycle through $ref terminates', () => {
    const doc = {
      $defs: {
        a: { allOf: [{ $ref: '#/$defs/b' }], properties: { a: { type: 'string' } } },
        b: { allOf: [{ $ref: '#/$defs/a' }], properties: { b: { type: 'string' } } },
      },
      allOf: [{ $ref: '#/$defs/a' }],
      type: 'object',
    };
    const tool = renderedToolFromJsonSchema('loop', null, doc);
    expect(tool.properties.map((property) => property.name)).toEqual(['a', 'b']);
    const self = { allOf: [{ $ref: '#' }], properties: { x: { type: 'string' } }, type: 'object' };
    expect(
      renderedToolFromJsonSchema('self', null, self).properties.map((property) => property.name),
    ).toEqual(['x']);
  });
});

describe('closed-level exclusion', () => {
  test('a closed level excludes names declared only in its branches or allOf members', () => {
    const tool = renderedToolFromJsonSchema('lookup', null, {
      additionalProperties: false,
      allOf: [{ properties: { scope: { type: 'string' } } }],
      anyOf: [{ properties: { by_id: { type: 'string' } } }],
      properties: { limit: { type: 'integer' } },
      type: 'object',
    });
    expect(tool.properties.map((property) => [property.name, property.excluded])).toEqual([
      ['limit', false],
      ['scope', true],
      ['by_id', true],
    ]);
  });

  test('a closed allOf member excludes at its level; a closed branch does not', () => {
    const tool = renderedToolFromJsonSchema('lookup', null, {
      allOf: [{ additionalProperties: false, properties: { scope: { type: 'string' } } }],
      anyOf: [
        { additionalProperties: false, properties: { by_id: { type: 'string' } } },
        { properties: { by_name: { type: 'string' } } },
      ],
      properties: { limit: { type: 'integer' } },
      type: 'object',
    });
    expect(tool.properties.map((property) => [property.name, property.excluded])).toEqual([
      ['limit', true],
      ['scope', false],
      ['by_id', true],
      ['by_name', true],
    ]);
  });

  test('patternProperties keep matching names acceptable at a closed level', () => {
    const tool = renderedToolFromJsonSchema('lookup', null, {
      additionalProperties: false,
      anyOf: [{ properties: { by_id: { type: 'string' } } }, { properties: { name: {} } }],
      patternProperties: { '^by_': { type: 'string' }, '[': {} },
      type: 'object',
    });
    expect(tool.properties.map((property) => [property.name, property.excluded])).toEqual([
      ['by_id', false],
      ['name', false],
    ]);
    const strict = renderedToolFromJsonSchema('lookup', null, {
      additionalProperties: false,
      anyOf: [{ properties: { by_id: { type: 'string' } } }, { properties: { name: {} } }],
      patternProperties: { '^by_': { type: 'string' } },
      type: 'object',
    });
    expect(strict.properties.map((property) => [property.name, property.excluded])).toEqual([
      ['by_id', false],
      ['name', true],
    ]);
  });

  test('closure applies at nested levels, and an open level excludes nothing', () => {
    const tool = renderedToolFromJsonSchema('search', null, {
      properties: {
        filter: {
          additionalProperties: false,
          anyOf: [{ properties: { mode: { type: 'string' } } }],
          type: 'object',
        },
        open: { anyOf: [{ properties: { any: { type: 'string' } } }], type: 'object' },
      },
      type: 'object',
    });
    expect(tool.properties[0]?.children?.[0]?.excluded).toBe(true);
    expect(tool.properties[1]?.children?.[0]?.excluded).toBe(false);
    expect(tool.properties.map((property) => property.excluded)).toEqual([false, false]);
  });
});
