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
    expect(message?.constraints).toEqual({ maxLength: 10 });
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
});
