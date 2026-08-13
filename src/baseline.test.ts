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
import type { BaselineDocument, Finding } from './types.js';

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
