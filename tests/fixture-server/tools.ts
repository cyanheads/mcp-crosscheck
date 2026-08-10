/**
 * @file tests/fixture-server/tools.ts
 * The fixture server's advertised tool surface, written as verbatim JSON
 * Schemas so what the server advertises is exactly what this file says — no
 * schema-generation layer in between. Each tool exists to exercise a specific
 * invariant or type-inference edge, so a client that mangles one of these
 * shapes is caught by name rather than by a vague whole-surface diff.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Server identity reported over `initialize`. */
export const FIXTURE_SERVER_NAME = 'crosscheck-fixture-server';

/** Fixed: the fixture is a test bed, not a released artifact. */
export const FIXTURE_SERVER_VERSION = '1.0.0';

export const FIXTURE_TOOLS: Tool[] = [
  {
    description:
      'Echo a message back as JSON. The canary tool: the handler returns the arguments it received, so a round-trip proves argument fidelity.',
    inputSchema: {
      properties: {
        message: {
          description: 'The message to echo back.',
          maxLength: 200,
          minLength: 1,
          type: 'string',
        },
        mode: {
          description: 'How to render the echoed message.',
          enum: ['standard', 'uppercase'],
          type: 'string',
        },
        repeat: {
          description: 'How many times to repeat the message.',
          maximum: 5,
          minimum: 1,
          type: 'integer',
        },
      },
      required: ['message'],
      type: 'object',
    },
    name: 'echo_message',
  },
  {
    description: 'Accept either mode A or mode B, expressed as a root anyOf over required.',
    inputSchema: {
      anyOf: [{ required: ['a'] }, { required: ['b'] }],
      properties: {
        a: { description: 'Mode A payload.', type: 'string' },
        b: { description: 'Mode B payload.', type: 'string' },
      },
      type: 'object',
    },
    name: 'union_modes',
  },
  {
    description:
      'Declare every field inside an anyOf branch, with no root properties at all — the shape that renders as an empty request body in converters that read properties/required only.',
    inputSchema: {
      anyOf: [
        {
          properties: { by_id: { description: 'Look up by identifier.', type: 'string' } },
          required: ['by_id'],
        },
        {
          properties: { by_name: { description: 'Look up by name.', type: 'string' } },
          required: ['by_name'],
        },
      ],
      type: 'object',
    },
    name: 'branch_only_fields',
  },
  {
    description:
      'Nest an object property two levels deep, with bounded scalars and an array. The only tool that advertises an outputSchema, itself nested: an array of objects and a sub-object, the shape converters turn into linked response models.',
    inputSchema: {
      properties: {
        config: {
          description: 'Connection configuration.',
          properties: {
            retries: {
              description: 'How many times to retry a failed request.',
              maximum: 10,
              minimum: 0,
              type: 'integer',
            },
            tags: {
              description: 'Free-form labels attached to the connection.',
              items: { type: 'string' },
              maxItems: 5,
              type: 'array',
            },
            transport: {
              description: 'Transport tuning.',
              properties: {
                keepAlive: { description: 'Hold the connection open.', type: 'boolean' },
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
    name: 'nested_config',
    outputSchema: {
      properties: {
        attempts: {
          description: 'One entry per connection attempt.',
          items: {
            properties: {
              durationMs: { description: 'How long the attempt took.', type: 'integer' },
              ok: { description: 'Whether the attempt succeeded.', type: 'boolean' },
            },
            required: ['ok', 'durationMs'],
            type: 'object',
          },
          type: 'array',
        },
        summary: {
          description: 'Aggregate outcome across every attempt.',
          properties: {
            connected: { description: 'Whether any attempt succeeded.', type: 'boolean' },
            endpoint: { description: 'The endpoint that was dialled.', type: 'string' },
          },
          required: ['connected'],
          type: 'object',
        },
      },
      required: ['attempts', 'summary'],
      type: 'object',
    },
  },
  {
    description: 'Carry the type-inference edges: an enum with no type, a const, and a type array.',
    inputSchema: {
      properties: {
        kind: { description: 'Enum with no declared type.', enum: ['alpha', 'beta'] },
        nullable_note: { description: 'A note, or null.', type: ['string', 'null'] },
        version: { const: 2, description: 'Fixed protocol version.' },
      },
      type: 'object',
    },
    name: 'typed_edges',
  },
  {
    description:
      'Take no arguments at all — the zero-argument shape empty-request-body must not flag.',
    inputSchema: { properties: {}, type: 'object' },
    name: 'no_args',
  },
];

/**
 * Structured payloads for the tools that advertise an `outputSchema`, keyed by
 * tool name. A tool that advertises one must answer with `structuredContent`:
 * the SDK client compiles a validator per advertised output schema at
 * `tools/list` and rejects a call result that carries none.
 */
export const FIXTURE_STRUCTURED_RESULTS: Record<string, Record<string, unknown>> = {
  nested_config: {
    attempts: [
      { durationMs: 12, ok: false },
      { durationMs: 4, ok: true },
    ],
    summary: { connected: true, endpoint: 'fixture://local' },
  },
};
