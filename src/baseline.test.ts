/**
 * @file src/baseline.test.ts
 * Strict baseline parsing, stable finding identity, reconciliation, and atomic writes.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BaselineValidationError,
  baselineEntryFromFinding,
  parseBaseline,
  reconcileBaseline,
  serializeBaseline,
  updateBaseline,
  writeBaselineAtomic,
} from './baseline.js';
import { compareSurface } from './invariants.js';
import { renderedPropertiesFromJsonSchema, renderedToolFromJsonSchema } from './schema.js';
import type {
  BaselineDocument,
  BaselineEntry,
  BaselineEvidence,
  Finding,
  GroundTruthTool,
} from './types.js';

const constraintFinding: Finding = {
  detail: 'wording is deliberately irrelevant to identity',
  evidence: { keywords: ['maxLength', 'minLength'], kind: 'constraint-dropped' },
  path: 'echo.message',
  rule: 'constraint-dropped',
  severity: 'info',
};

const EMPTY: BaselineDocument = { baselineVersion: 1, entries: [] };

describe('baseline parser and serialization', () => {
  test('serializes recursively canonical keys, sorted entries, and a trailing newline', () => {
    const document: BaselineDocument = {
      baselineVersion: 1,
      entries: [
        {
          adapter: 'mcpo',
          evidence: { names: ['a', 'b'], kind: 'required-dropped' },
          path: 'echo',
          rule: 'required-dropped',
        },
        {
          adapter: 'codex',
          evidence: { keywords: ['maxLength', 'minLength'], kind: 'constraint-dropped' },
          path: 'echo.message',
          rule: 'constraint-dropped',
        },
      ],
    };
    const serialized = serializeBaseline(document);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized).toBe(serializeBaseline(parseBaseline(serialized)));
    expect(
      JSON.parse(serialized).entries.map((entry: { adapter: string }) => entry.adapter),
    ).toEqual(['codex', 'mcpo']);
  });

  test('orders entries by code unit whatever the input order or host locale', () => {
    const entry = (path: string, names = ['id']): BaselineEntry => ({
      adapter: 'mcpo',
      evidence: { kind: 'required-dropped', names },
      path,
      rule: 'required-dropped',
    });
    // A soft hyphen (U+00AD) is ignorable to `localeCompare`, which calls `ab` and `a­b` equal;
    // `localeCompare` also sorts `a` before `B`, where code-unit order puts `B` (0x42) first.
    const entries = [
      entry('ab'),
      entry('a­b'),
      entry('a'),
      entry('B'),
      entry('x', ['a']),
      entry('x', ['B']),
    ];
    const forward = serializeBaseline({ baselineVersion: 1, entries });
    const reverse = serializeBaseline({ baselineVersion: 1, entries: [...entries].reverse() });
    expect(reverse).toBe(forward);
    expect(
      parseBaseline(forward).entries.map((parsed) => [
        parsed.path,
        parsed.evidence.kind === 'required-dropped' ? parsed.evidence.names : null,
      ]),
    ).toEqual([
      ['B', ['id']],
      ['a', ['id']],
      ['ab', ['id']],
      ['a­b', ['id']],
      ['x', ['B']],
      ['x', ['a']],
    ]);
  });

  test('normalizes only evidence set arrays so serialized typed documents parse immediately', () => {
    const document: BaselineDocument = {
      baselineVersion: 1,
      entries: [
        {
          adapter: 'mcpo',
          evidence: { kind: 'required-dropped', names: ['z', 'a', 'z'] },
          path: 'echo',
          rule: 'required-dropped',
        },
        {
          adapter: 'codex',
          evidence: { keywords: ['minimum', 'maximum'], kind: 'constraint-dropped' },
          path: 'echo.count',
          rule: 'constraint-dropped',
        },
      ],
    };
    const parsed = parseBaseline(serializeBaseline(document));
    expect(parsed.entries.map((entry) => entry.evidence)).toEqual([
      { keywords: ['maximum', 'minimum'], kind: 'constraint-dropped' },
      { kind: 'required-dropped', names: ['a', 'z'] },
    ]);
  });

  test('rejects malformed, unsupported, duplicate, unknown, runtime, mismatched, and noncanonical entries', () => {
    const validEntry = {
      adapter: 'mcpo',
      evidence: { kind: 'tool-missing' },
      path: 'echo',
      rule: 'tool-missing',
    };
    const invalidDocuments = [
      'not json',
      JSON.stringify({ baselineVersion: 2, entries: [] }),
      JSON.stringify({ baselineVersion: 1, entries: [validEntry, validEntry] }),
      JSON.stringify({ baselineVersion: 1, entries: [{ ...validEntry, adapter: 'unknown' }] }),
      JSON.stringify({
        baselineVersion: 1,
        entries: [{ ...validEntry, evidence: { kind: 'adapter-broken' }, rule: 'adapter-broken' }],
      }),
      JSON.stringify({
        baselineVersion: 1,
        entries: [{ ...validEntry, evidence: { kind: 'anyof-ignored' } }],
      }),
      JSON.stringify({ baselineVersion: 1, entries: [{ ...validEntry, path: null }] }),
      JSON.stringify({
        baselineVersion: 1,
        entries: [
          {
            adapter: 'mcpo',
            evidence: { keywords: ['minLength', 'maxLength'], kind: 'constraint-dropped' },
            path: 'echo.message',
            rule: 'constraint-dropped',
          },
        ],
      }),
    ];
    for (const text of invalidDocuments) {
      expect(() => parseBaseline(text)).toThrow(BaselineValidationError);
    }
  });

  test('altered description and constraint evidence round-trips', () => {
    const findings: Finding[] = [
      {
        detail:
          'tool description was rewritten in rendering (72 characters advertised, 69 rendered)',
        evidence: { change: 'rewritten', kind: 'description-altered', subject: 'tool' },
        path: 'union_modes',
        rule: 'description-altered',
        severity: 'info',
      },
      {
        detail: 'constraint values changed: maximum 100 → 3, minimum 5 → 0',
        evidence: { keywords: ['maximum', 'minimum'], kind: 'constraint-altered' },
        path: 'set.n',
        rule: 'constraint-altered',
        severity: 'info',
      },
    ];
    const updated = updateBaseline(EMPTY, [
      { adapter: 'claude-code', comparisonSucceeded: true, findings },
    ]);
    const serialized = serializeBaseline(updated);
    expect(parseBaseline(serialized)).toEqual(updated);
    expect(updated.entries.map((entry) => [entry.rule, entry.evidence])).toEqual([
      ['constraint-altered', { keywords: ['maximum', 'minimum'], kind: 'constraint-altered' }],
      [
        'description-altered',
        { change: 'rewritten', kind: 'description-altered', subject: 'tool' },
      ],
    ]);

    const reread = reconcileBaseline(parseBaseline(serialized), [
      {
        adapter: 'claude-code',
        comparisonSucceeded: true,
        findings: findings.map((finding) => ({ ...finding, detail: 'lengths moved' })),
      },
    ]);
    expect(reread.adapters[0]?.acknowledgedFindings).toHaveLength(2);
    expect(reread.adapters[0]?.newFindings).toEqual([]);
    expect(reread.baselineDiagnostics).toEqual([]);

    const typed: BaselineDocument = {
      baselineVersion: 1,
      entries: [
        {
          adapter: 'codex',
          evidence: { keywords: ['minimum', 'maximum', 'minimum'], kind: 'constraint-altered' },
          path: 'set.n',
          rule: 'constraint-altered',
        },
      ],
    };
    expect(parseBaseline(serializeBaseline(typed)).entries[0]?.evidence).toEqual({
      keywords: ['maximum', 'minimum'],
      kind: 'constraint-altered',
    });
  });

  test('rejects malformed altered description and constraint evidence', () => {
    const entry = (rule: string, evidence: Record<string, unknown>) =>
      JSON.stringify({
        baselineVersion: 1,
        entries: [{ adapter: 'mcpo', evidence, path: 'echo', rule }],
      });
    const invalid = [
      entry('constraint-altered', { keywords: ['minimum', 'maximum'], kind: 'constraint-altered' }),
      entry('constraint-altered', { keywords: ['maximum', 'maximum'], kind: 'constraint-altered' }),
      entry('constraint-dropped', { keywords: ['maximum'], kind: 'constraint-altered' }),
      entry('description-altered', {
        change: 'shortened',
        kind: 'description-altered',
        subject: 'tool',
      }),
      entry('description-altered', { change: 'truncated', kind: 'description-altered' }),
      entry('description-altered', {
        change: 'truncated',
        kind: 'description-altered',
        length: 20,
        subject: 'tool',
      }),
      entry('description-lost', {
        change: 'truncated',
        kind: 'description-altered',
        subject: 'tool',
      }),
    ];
    for (const text of invalid) {
      expect(() => parseBaseline(text)).toThrow(BaselineValidationError);
    }
    expect(
      parseBaseline(
        entry('description-altered', {
          change: 'truncated',
          kind: 'description-altered',
          subject: 'property',
        }),
      ).entries,
    ).toHaveLength(1);
  });

  test('property-excluded evidence round-trips from an engine finding', () => {
    const inputSchema = {
      anyOf: [{ properties: { by_id: { type: 'string' } } }],
      type: 'object',
    };
    const findings = compareSurface([{ description: 'Look up.', inputSchema, name: 'lookup' }], {
      tools: [
        renderedToolFromJsonSchema('lookup', 'Look up.', {
          ...inputSchema,
          additionalProperties: false,
          properties: {},
        }),
      ],
    });
    expect(findings.map((finding) => [finding.rule, finding.path, finding.evidence])).toEqual([
      ['property-excluded', 'lookup.by_id', { kind: 'property-excluded' }],
    ]);
    const updated = updateBaseline(EMPTY, [
      { adapter: 'mcpo', comparisonSucceeded: true, findings },
    ]);
    const serialized = serializeBaseline(updated);
    expect(parseBaseline(serialized)).toEqual(updated);
    expect(updated.entries).toEqual([
      {
        adapter: 'mcpo',
        evidence: { kind: 'property-excluded' },
        path: 'lookup.by_id',
        rule: 'property-excluded',
      },
    ]);
    const reread = reconcileBaseline(parseBaseline(serialized), [
      { adapter: 'mcpo', comparisonSucceeded: true, findings },
    ]);
    expect(reread.adapters[0]?.acknowledgedFindings).toHaveLength(1);
    expect(reread.baselineDiagnostics).toEqual([]);

    const entry = (rule: string, evidence: Record<string, unknown>) =>
      JSON.stringify({
        baselineVersion: 1,
        entries: [{ adapter: 'mcpo', evidence, path: 'lookup.by_id', rule }],
      });
    for (const text of [
      entry('property-excluded', { declaredIn: 'branch', kind: 'property-excluded' }),
      entry('property-missing', { kind: 'property-excluded' }),
      entry('property-excluded', { declaredIn: 'branch', kind: 'property-missing' }),
    ]) {
      expect(() => parseBaseline(text)).toThrow(BaselineValidationError);
    }
  });

  test('finding identity ignores detail and rejects runtime/null-path findings', () => {
    const entry = baselineEntryFromFinding('mcpo', constraintFinding);
    expect(entry).toEqual({
      adapter: 'mcpo',
      evidence: { keywords: ['maxLength', 'minLength'], kind: 'constraint-dropped' },
      path: 'echo.message',
      rule: 'constraint-dropped',
    });
    expect(
      baselineEntryFromFinding('mcpo', {
        ...constraintFinding,
        detail: 'completely changed prose',
      }),
    ).toEqual(entry);
    expect(
      baselineEntryFromFinding('mcpo', {
        detail: 'runtime',
        evidence: { kind: 'canary-failed' },
        path: null,
        rule: 'canary-failed',
        severity: 'fail',
      }),
    ).toBeNull();
  });

  test('ground-truth notes are never baselined, and an entry naming one fails strict parsing', () => {
    const dialect = {
      declared: 'http://json-schema.org/draft-04/schema#',
      kind: 'unsupported-dialect',
    };
    const note: Finding = {
      detail: 'output schema declares an unrecognized dialect',
      evidence: { declared: dialect.declared, kind: 'unsupported-dialect' },
      path: 'output:legacy',
      rule: 'unsupported-dialect',
      severity: 'info',
    };
    expect(baselineEntryFromFinding('mcpo', note)).toBeNull();
    const states = [{ adapter: 'mcpo' as const, comparisonSucceeded: true, findings: [note] }];
    expect(updateBaseline(EMPTY, states)).toEqual(EMPTY);
    expect(reconcileBaseline(EMPTY, states).adapters[0]?.newFindings).toEqual([note]);

    const entry = (rule: string, evidence: Record<string, unknown>) =>
      JSON.stringify({
        baselineVersion: 1,
        entries: [{ adapter: 'mcpo', evidence, path: 'output:legacy', rule }],
      });
    expect(() => parseBaseline(entry('unsupported-dialect', dialect))).toThrow(
      'rule "unsupported-dialect" is not baselineable',
    );
    for (const text of [
      entry('unsupported-dialect', { kind: 'tool-missing' }),
      entry('tool-missing', dialect),
    ]) {
      expect(() => parseBaseline(text)).toThrow(BaselineValidationError);
    }
  });

  test('an sdk-v1-rejected note is never baselined, and an entry naming it fails strict parsing', () => {
    const note: Finding = {
      detail: 'clients on @modelcontextprotocol/sdk 1.x reject this tool',
      evidence: { kind: 'sdk-v1-rejected' },
      path: 'any_tool',
      rule: 'sdk-v1-rejected',
      severity: 'info',
    };
    expect(baselineEntryFromFinding('inspector', note)).toBeNull();
    const states = [{ adapter: 'inspector' as const, comparisonSucceeded: true, findings: [note] }];
    expect(updateBaseline(EMPTY, states)).toEqual(EMPTY);

    const entry = (rule: string, evidence: Record<string, unknown>) =>
      JSON.stringify({
        baselineVersion: 1,
        entries: [{ adapter: 'inspector', evidence, path: 'any_tool', rule }],
      });
    expect(() => parseBaseline(entry('sdk-v1-rejected', { kind: 'sdk-v1-rejected' }))).toThrow(
      'rule "sdk-v1-rejected" is not baselineable',
    );
    expect(() => parseBaseline(entry('tool-missing', { kind: 'sdk-v1-rejected' }))).toThrow(
      BaselineValidationError,
    );
  });
});

describe('baseline reconciliation and updates', () => {
  const entry = baselineEntryFromFinding('mcpo', constraintFinding)!;

  test('separates new, acknowledged, and stale without parsing detail', () => {
    const result = reconcileBaseline({ baselineVersion: 1, entries: [entry] }, [
      {
        adapter: 'mcpo',
        comparisonSucceeded: true,
        findings: [{ ...constraintFinding, detail: 'new prose' }],
      },
    ]);
    expect(result.adapters[0]?.newFindings).toEqual([]);
    expect(result.adapters[0]?.acknowledgedFindings).toHaveLength(1);
    expect(result.baselineDiagnostics).toEqual([]);

    const stale = reconcileBaseline({ baselineVersion: 1, entries: [entry] }, [
      { adapter: 'mcpo', comparisonSucceeded: true, findings: [] },
    ]);
    expect(stale.baselineDiagnostics).toEqual([{ adapter: 'mcpo', entry, kind: 'stale' }]);
  });

  test('an entry for untyped ground truth still parses and reconciles as stale', () => {
    const legacy = parseBaseline(
      JSON.stringify({
        baselineVersion: 1,
        entries: [
          {
            adapter: 'inspector',
            evidence: { groundTruthType: null, kind: 'property-untyped' },
            path: 'echo.payload',
            rule: 'property-untyped',
          },
        ],
      }),
    );
    const untypedSchema = { properties: { payload: { description: 'Anything.' } }, type: 'object' };
    const findings = compareSurface(
      [{ description: 'Echo.', inputSchema: untypedSchema, name: 'echo' }],
      { tools: [renderedToolFromJsonSchema('echo', 'Echo.', untypedSchema)] },
    );
    const result = reconcileBaseline(legacy, [
      { adapter: 'inspector', comparisonSucceeded: true, findings },
    ]);
    expect(result.adapters[0]?.newFindings).toEqual([]);
    expect(result.baselineDiagnostics).toEqual([
      { adapter: 'inspector', entry: legacy.entries[0]!, kind: 'stale' },
    ]);
  });

  test('entries a 0.1.0 header-redacted run wrote still parse and reconcile as stale', () => {
    // 0.1.0 redacted evidence too: `Accept-Language: en` rewrote maxLength, and
    // header values `integer` and `number` reduced a retyping to from === to.
    const legacy = parseBaseline(
      JSON.stringify({
        baselineVersion: 1,
        entries: [
          {
            adapter: 'codex',
            evidence: {
              keywords: ['maxL[REDACTED]gth', 'minL[REDACTED]gth'],
              kind: 'constraint-dropped',
            },
            path: 'echo.message',
            rule: 'constraint-dropped',
          },
          {
            adapter: 'codex',
            evidence: { from: '[REDACTED]', kind: 'property-retyped', to: '[REDACTED]' },
            path: 'echo.count',
            rule: 'property-retyped',
          },
        ],
      }),
    );
    expect(parseBaseline(serializeBaseline(legacy))).toEqual(legacy);
    const result = reconcileBaseline(legacy, [
      { adapter: 'codex', comparisonSucceeded: true, findings: [constraintFinding] },
    ]);
    expect(result.adapters[0]?.newFindings).toEqual([constraintFinding]);
    expect(result.baselineDiagnostics.map((diagnostic) => diagnostic.entry)).toEqual(
      legacy.entries,
    );
  });

  test('unselected and failed adapters are preserved and never stale', () => {
    const baseline = { baselineVersion: 1 as const, entries: [entry] };
    expect(reconcileBaseline(baseline, []).baselineDiagnostics).toEqual([]);
    expect(
      reconcileBaseline(baseline, [{ adapter: 'mcpo', comparisonSucceeded: false, findings: [] }])
        .baselineDiagnostics,
    ).toEqual([]);
    expect(updateBaseline(baseline, [])).toEqual(baseline);
    expect(
      updateBaseline(baseline, [{ adapter: 'mcpo', comparisonSucceeded: false, findings: [] }]),
    ).toEqual(baseline);
  });

  test('selected successful adapters replace current entries while unselected entries survive', () => {
    const codexEntry = { ...entry, adapter: 'codex' as const };
    expect(
      updateBaseline({ baselineVersion: 1, entries: [entry, codexEntry] }, [
        { adapter: 'mcpo', comparisonSucceeded: true, findings: [] },
      ]),
    ).toEqual({ baselineVersion: 1, entries: [codexEntry] });
  });
});

describe('canonical finding identity', () => {
  /** Every rendering evidence kind; `satisfies` fails the typecheck when a new kind is not listed. */
  const EVERY_KIND = {
    'anyof-ignored': true,
    'constraint-altered': true,
    'constraint-dropped': true,
    'description-altered': true,
    'description-lost': true,
    'input-empty': true,
    'output-field-missing': true,
    'output-field-retyped': true,
    'output-field-untyped': true,
    'output-nested-empty': true,
    'output-root-empty': true,
    'property-excluded': true,
    'property-missing': true,
    'property-retyped': true,
    'property-untyped': true,
    'required-dropped': true,
    'tool-missing': true,
  } satisfies Record<BaselineEvidence['kind'], true>;

  /** Update an empty baseline from these findings, then reconcile the same findings against it. */
  function roundTrip(findings: Finding[]) {
    const states = [{ adapter: 'mcpo' as const, comparisonSucceeded: true, findings }];
    const updated = updateBaseline(EMPTY, states);
    return { reconciled: reconcileBaseline(updated, states), updated };
  }

  test('every evidence kind the engine emits parses back and acknowledges its finding', () => {
    const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      properties,
      type: 'object',
      ...extra,
    });
    const groundTruth: GroundTruthTool[] = [
      { description: 'Unnamed.', inputSchema: object({}), name: '' },
      {
        description: 'Union.',
        inputSchema: object({ a: { type: 'string' } }, { anyOf: [{ required: ['a'] }] }),
        name: 'union',
      },
      {
        description: 'Look up.',
        inputSchema: { anyOf: [{ properties: { by_id: { type: 'string' } } }], type: 'object' },
        name: 'lookup',
      },
      { description: 'Empty.', inputSchema: object({ a: { type: 'string' } }), name: 'empty' },
      {
        description: 'Edge cases.',
        inputSchema: object(
          {
            bare: { type: '' },
            blank: { type: '' },
            gone: { type: 'string' },
            nested: object({ x: { type: 'string' } }),
            said: { description: 'Said.', type: 'string' },
            text: { description: 'Text here.', maxLength: 5, minLength: 1, type: 'string' },
          },
          { required: [''] },
        ),
        name: 'edge',
        outputSchema: object({
          gone: { type: 'string' },
          nested: object({ y: { type: 'string' } }),
          retyped: { type: '' },
          typed: { type: '' },
        }),
      },
      {
        description: 'Quiet.',
        inputSchema: object({}),
        name: 'quiet',
        outputSchema: object({ z: { type: 'string' } }),
      },
    ];
    const edge = renderedToolFromJsonSchema(
      'edge',
      'Edge cases.',
      object({
        bare: {},
        blank: { type: 'string' },
        nested: { type: 'object' },
        said: { type: 'string' },
        text: { description: 'Text', maxLength: 9, type: 'string' },
      }),
    );
    edge.outputProperties = renderedPropertiesFromJsonSchema(
      object({ nested: { type: 'object' }, retyped: { type: 'integer' }, typed: {} }),
    );
    const quiet = renderedToolFromJsonSchema('quiet', 'Quiet.', object({}));
    quiet.outputProperties = [];
    const findings = compareSurface(groundTruth, {
      tools: [
        renderedToolFromJsonSchema('union', 'Union.', object({ a: { type: 'string' } })),
        renderedToolFromJsonSchema('lookup', 'Look up.', {
          ...groundTruth[2]!.inputSchema,
          additionalProperties: false,
          properties: {},
        }),
        renderedToolFromJsonSchema('empty', 'Empty.', object({})),
        edge,
        quiet,
      ],
    });

    expect(new Set<string>(findings.map((finding) => finding.evidence.kind))).toEqual(
      new Set(Object.keys(EVERY_KIND)),
    );
    expect(findings.map((finding) => [finding.path, finding.evidence])).toEqual(
      expect.arrayContaining([
        ['', { kind: 'tool-missing' }],
        ['edge.bare', { groundTruthType: '', kind: 'property-untyped' }],
        ['edge.blank', { from: '', kind: 'property-retyped', to: 'string' }],
        ['edge', { kind: 'required-dropped', names: [''] }],
        ['output:edge.typed', { groundTruthType: '', kind: 'output-field-untyped' }],
        ['output:edge.retyped', { from: '', kind: 'output-field-retyped', to: 'integer' }],
      ]),
    );
    const { reconciled, updated } = roundTrip(findings);
    expect(parseBaseline(serializeBaseline(updated))).toEqual(updated);
    expect(updated.entries).toHaveLength(findings.length);
    expect(reconciled.adapters[0]?.newFindings).toEqual([]);
    expect(reconciled.adapters[0]?.acknowledgedFindings).toEqual(findings);
    expect(reconciled.baselineDiagnostics).toEqual([]);
  });

  test('findings that share one identity write one entry that acknowledges each', () => {
    const described = { description: 'Described.', type: 'string' };
    const toolA = (c: object) => ({
      properties: { b: { properties: { c }, type: 'object' } },
      type: 'object',
    });
    const toolAB = (c: object) => ({ properties: { c }, type: 'object' });
    const groundTruth: GroundTruthTool[] = [
      { description: 'A.', inputSchema: toolA(described), name: 'a' },
      { description: 'AB.', inputSchema: toolAB(described), name: 'a.b' },
      { description: 'A.', inputSchema: toolA(described), name: 'a' },
    ];
    const plain = { type: 'string' };
    const findings = compareSurface(groundTruth, {
      tools: [
        renderedToolFromJsonSchema('a', 'A.', toolA(plain)),
        renderedToolFromJsonSchema('a.b', 'AB.', toolAB(plain)),
      ],
    });
    expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([
      ['description-lost', 'a.b.c'],
      ['description-lost', 'a.b.c'],
      ['description-lost', 'a.b.c'],
    ]);
    const { reconciled, updated } = roundTrip(findings);
    expect(updated.entries).toEqual([
      {
        adapter: 'mcpo',
        evidence: { kind: 'description-lost', subject: 'property' },
        path: 'a.b.c',
        rule: 'description-lost',
      },
    ]);
    expect(reconciled.adapters[0]?.acknowledgedFindings).toEqual(findings);
    expect(reconciled.baselineDiagnostics).toEqual([]);
  });

  test('a finding carrying repeated or unsorted set members matches the entry it writes', () => {
    const findings: Finding[] = [
      {
        detail: 'required marker dropped for: id, id',
        evidence: { kind: 'required-dropped', names: ['name', 'id', 'id'] },
        path: 'lookup',
        rule: 'required-dropped',
        severity: 'fail',
      },
      {
        detail: 'constraint keywords dropped',
        evidence: { keywords: ['minimum', 'maximum', 'minimum'], kind: 'constraint-dropped' },
        path: 'lookup.n',
        rule: 'constraint-dropped',
        severity: 'info',
      },
    ];
    const { reconciled, updated } = roundTrip(findings);
    expect(updated.entries.map((entry) => entry.evidence)).toEqual([
      { keywords: ['maximum', 'minimum'], kind: 'constraint-dropped' },
      { kind: 'required-dropped', names: ['id', 'name'] },
    ]);
    expect(reconciled.adapters[0]?.acknowledgedFindings).toEqual(findings);
    expect(reconciled.baselineDiagnostics).toEqual([]);
  });

  test('rejects evidence the engine never emits', () => {
    const entry = (rule: string, evidence: Record<string, unknown>) =>
      JSON.stringify({
        baselineVersion: 1,
        entries: [{ adapter: 'mcpo', evidence, path: 'echo', rule }],
      });
    const invalid = [
      entry('constraint-dropped', { keywords: [], kind: 'constraint-dropped' }),
      entry('constraint-altered', { keywords: [], kind: 'constraint-altered' }),
      entry('required-dropped', { kind: 'required-dropped', names: [] }),
      entry('constraint-dropped', { keywords: ['maxlength'], kind: 'constraint-dropped' }),
      entry('property-retyped', { from: 'string', kind: 'property-retyped', to: 'string' }),
      entry('output-schema-divergence', { from: '', kind: 'output-field-retyped', to: '' }),
      entry('property-untyped', { groundTruthType: 7, kind: 'property-untyped' }),
      entry('required-dropped', { kind: 'required-dropped', names: [7] }),
    ];
    for (const text of invalid) {
      expect(() => parseBaseline(text)).toThrow(BaselineValidationError);
    }
  });
});

describe('atomic baseline writes', () => {
  test('repeated writes are byte-identical and replace without pretruncation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-baseline-'));
    const path = join(dir, 'baseline.json');
    try {
      await writeBaselineAtomic(path, EMPTY);
      const first = await readFile(path, 'utf8');
      await writeBaselineAtomic(path, EMPTY);
      expect(await readFile(path, 'utf8')).toBe(first);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test('rename failure preserves the destination and cleans the temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosscheck-baseline-'));
    const path = join(dir, 'baseline.json');
    await writeFile(path, 'original\n');
    try {
      await expect(
        writeBaselineAtomic(path, EMPTY, {
          rename: async () => {
            throw new Error('injected rename failure');
          },
        }),
      ).rejects.toThrow('injected rename failure');
      expect(await readFile(path, 'utf8')).toBe('original\n');
      expect(await readdir(dir)).toEqual(['baseline.json']);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
