/**
 * @file src/baseline.ts
 * Strict version-1 baseline validation, finding reconciliation, and atomic persistence.
 */
import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type {
  AdapterName,
  BaselineableRuleId,
  BaselineDiagnostic,
  BaselineDocument,
  BaselineEntry,
  BaselineEvidence,
  Finding,
} from './types.js';

const ADAPTERS = new Set<AdapterName>(['claude-code', 'codex', 'inspector', 'mcpo']);
const RUNTIME_RULES = new Set(['adapter-broken', 'canary-failed', 'handshake-failure']);
const RULE_FOR_KIND: Record<BaselineEvidence['kind'], BaselineableRuleId> = {
  'anyof-ignored': 'anyof-ignored',
  'constraint-dropped': 'constraint-dropped',
  'description-lost': 'description-lost',
  'input-empty': 'empty-request-body',
  'output-field-missing': 'output-schema-divergence',
  'output-field-retyped': 'output-schema-divergence',
  'output-field-untyped': 'output-schema-divergence',
  'output-nested-empty': 'output-schema-divergence',
  'output-root-empty': 'output-schema-divergence',
  'property-missing': 'property-missing',
  'property-retyped': 'property-retyped',
  'property-untyped': 'property-untyped',
  'required-dropped': 'required-dropped',
  'tool-missing': 'tool-missing',
};

/** An actionable baseline document error; callers expose it as a usage error. */
export class BaselineValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isSortedUniqueStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry, index) =>
        typeof entry === 'string' &&
        entry !== '' &&
        (index === 0 || (value[index - 1] as string) < entry),
    )
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value !== '');
}

function parseEvidence(value: unknown): BaselineEvidence {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new BaselineValidationError('baseline evidence must be an object with a known kind');
  }
  switch (value.kind) {
    case 'tool-missing':
    case 'anyof-ignored':
    case 'output-field-missing':
      if (hasExactKeys(value, ['kind'])) return value as BaselineEvidence;
      break;
    case 'input-empty':
      if (
        hasExactKeys(value, ['branchOnly', 'expectedPropertyCount', 'kind', 'scope']) &&
        typeof value.branchOnly === 'boolean' &&
        positiveInteger(value.expectedPropertyCount) &&
        (value.scope === 'root' || value.scope === 'nested')
      ) {
        return value as BaselineEvidence;
      }
      break;
    case 'property-missing':
      if (
        hasExactKeys(value, ['declaredIn', 'kind']) &&
        (value.declaredIn === 'root' || value.declaredIn === 'branch')
      ) {
        return value as BaselineEvidence;
      }
      break;
    case 'property-untyped':
    case 'output-field-untyped':
      if (
        hasExactKeys(value, ['groundTruthType', 'kind']) &&
        nullableString(value.groundTruthType)
      ) {
        return value as BaselineEvidence;
      }
      break;
    case 'property-retyped':
    case 'output-field-retyped':
      if (
        hasExactKeys(value, ['from', 'kind', 'to']) &&
        nullableString(value.from) &&
        nullableString(value.to) &&
        value.from !== null &&
        value.to !== null
      ) {
        return value as BaselineEvidence;
      }
      break;
    case 'description-lost':
      if (
        hasExactKeys(value, ['kind', 'subject']) &&
        (value.subject === 'tool' || value.subject === 'property')
      ) {
        return value as BaselineEvidence;
      }
      break;
    case 'constraint-dropped':
      if (hasExactKeys(value, ['keywords', 'kind']) && isSortedUniqueStrings(value.keywords)) {
        return value as BaselineEvidence;
      }
      break;
    case 'required-dropped':
      if (hasExactKeys(value, ['kind', 'names']) && isSortedUniqueStrings(value.names)) {
        return value as BaselineEvidence;
      }
      break;
    case 'output-root-empty':
    case 'output-nested-empty':
      if (
        hasExactKeys(value, ['expectedPropertyCount', 'kind']) &&
        positiveInteger(value.expectedPropertyCount)
      ) {
        return value as BaselineEvidence;
      }
      break;
  }
  throw new BaselineValidationError(`invalid baseline evidence for kind "${value.kind}"`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalEvidence(evidence: BaselineEvidence): string {
  return JSON.stringify(canonicalize(evidence));
}

function normalizeEvidenceSets(evidence: BaselineEvidence): BaselineEvidence {
  if (evidence.kind === 'constraint-dropped') {
    return { ...evidence, keywords: [...new Set(evidence.keywords)].sort() };
  }
  if (evidence.kind === 'required-dropped') {
    return { ...evidence, names: [...new Set(evidence.names)].sort() };
  }
  return evidence;
}

function compareEntries(left: BaselineEntry, right: BaselineEntry): number {
  return (
    left.adapter.localeCompare(right.adapter) ||
    left.rule.localeCompare(right.rule) ||
    left.path.localeCompare(right.path) ||
    canonicalEvidence(left.evidence).localeCompare(canonicalEvidence(right.evidence))
  );
}

function entryIdentity(entry: BaselineEntry): string {
  return `${entry.adapter}\u0000${entry.rule}\u0000${entry.path}\u0000${canonicalEvidence(entry.evidence)}`;
}

function parseEntry(value: unknown): BaselineEntry {
  if (!isRecord(value) || !hasExactKeys(value, ['adapter', 'evidence', 'path', 'rule'])) {
    throw new BaselineValidationError(
      'each baseline entry must contain adapter, rule, path, evidence',
    );
  }
  if (typeof value.adapter !== 'string' || !ADAPTERS.has(value.adapter as AdapterName)) {
    throw new BaselineValidationError(`unknown baseline adapter "${String(value.adapter)}"`);
  }
  if (typeof value.rule !== 'string' || RUNTIME_RULES.has(value.rule)) {
    throw new BaselineValidationError(`rule "${String(value.rule)}" is not baselineable`);
  }
  if (typeof value.path !== 'string' || value.path === '') {
    throw new BaselineValidationError('baseline entry path must be a non-empty string');
  }
  const evidence = parseEvidence(value.evidence);
  const expectedRule = RULE_FOR_KIND[evidence.kind];
  if (value.rule !== expectedRule) {
    throw new BaselineValidationError(
      `baseline rule "${value.rule}" does not match evidence kind "${evidence.kind}"`,
    );
  }
  return {
    adapter: value.adapter as AdapterName,
    evidence,
    path: value.path,
    rule: expectedRule,
  };
}

/** Parse and validate a strict version-1 baseline document. */
export function parseBaseline(text: string): BaselineDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BaselineValidationError('baseline is not valid JSON');
  }
  if (!isRecord(value) || !hasExactKeys(value, ['baselineVersion', 'entries'])) {
    throw new BaselineValidationError('baseline must contain only baselineVersion and entries');
  }
  if (value.baselineVersion !== 1) {
    throw new BaselineValidationError(
      `unsupported baselineVersion ${String(value.baselineVersion)}`,
    );
  }
  if (!Array.isArray(value.entries)) {
    throw new BaselineValidationError('baseline entries must be an array');
  }
  const entries = value.entries.map(parseEntry).sort(compareEntries);
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = entryIdentity(entry);
    if (identities.has(identity)) {
      throw new BaselineValidationError(
        `duplicate baseline entry for ${entry.adapter}/${entry.rule}/${entry.path}`,
      );
    }
    identities.add(identity);
  }
  return { baselineVersion: 1, entries };
}

/** Serialize a deterministic canonical version-1 baseline. */
export function serializeBaseline(document: BaselineDocument): string {
  const entries = document.entries
    .map((entry) => ({ ...entry, evidence: normalizeEvidenceSets(entry.evidence) }))
    .sort(compareEntries);
  return `${JSON.stringify(canonicalize({ baselineVersion: 1, entries }), null, 2)}\n`;
}

/** Convert one rendering finding to its persisted identity; runtime findings return null. */
export function baselineEntryFromFinding(
  adapter: AdapterName,
  finding: Finding,
): BaselineEntry | null {
  if (
    finding.path === null ||
    finding.evidence.kind === 'adapter-broken' ||
    finding.evidence.kind === 'canary-failed' ||
    finding.evidence.kind === 'handshake-failure'
  ) {
    return null;
  }
  return {
    adapter,
    evidence: finding.evidence,
    path: finding.path,
    rule: finding.rule as BaselineableRuleId,
  };
}

/** Adapter comparison state consumed by reconciliation and update logic. */
export interface BaselineAdapterState {
  adapter: AdapterName;
  comparisonSucceeded: boolean;
  findings: Finding[];
}

export interface BaselineReconciliation {
  adapters: {
    acknowledgedFindings: Finding[];
    adapter: AdapterName;
    newFindings: Finding[];
  }[];
  baselineDiagnostics: BaselineDiagnostic[];
}

/** Partition current findings and report stale entries for successful selected comparisons. */
export function reconcileBaseline(
  baseline: BaselineDocument,
  states: BaselineAdapterState[],
): BaselineReconciliation {
  const baselineIdentities = new Set(baseline.entries.map(entryIdentity));
  const currentIdentities = new Set<string>();
  const adapters = states.map((state) => {
    const acknowledgedFindings: Finding[] = [];
    const newFindings: Finding[] = [];
    for (const finding of state.findings) {
      const entry = baselineEntryFromFinding(state.adapter, finding);
      if (state.comparisonSucceeded && entry !== null) currentIdentities.add(entryIdentity(entry));
      if (
        state.comparisonSucceeded &&
        entry !== null &&
        baselineIdentities.has(entryIdentity(entry))
      ) {
        acknowledgedFindings.push(finding);
      } else {
        newFindings.push(finding);
      }
    }
    return { acknowledgedFindings, adapter: state.adapter, newFindings };
  });
  const successful = new Set(
    states.filter((state) => state.comparisonSucceeded).map((state) => state.adapter),
  );
  const baselineDiagnostics = baseline.entries
    .filter(
      (entry) => successful.has(entry.adapter) && !currentIdentities.has(entryIdentity(entry)),
    )
    .map((entry) => ({ adapter: entry.adapter, entry, kind: 'stale' }) as const);
  return { adapters, baselineDiagnostics };
}

/** Replace entries only for selected adapters whose rendered surface comparison succeeded. */
export function updateBaseline(
  baseline: BaselineDocument,
  states: BaselineAdapterState[],
): BaselineDocument {
  const replace = new Set(
    states.filter((state) => state.comparisonSucceeded).map((state) => state.adapter),
  );
  const entries = baseline.entries.filter((entry) => !replace.has(entry.adapter));
  for (const state of states) {
    if (!state.comparisonSucceeded) continue;
    for (const finding of state.findings) {
      const entry = baselineEntryFromFinding(state.adapter, finding);
      if (entry !== null) entries.push(entry);
    }
  }
  return parseBaseline(serializeBaseline({ baselineVersion: 1, entries }));
}

interface BaselineWriteOperations {
  rename: typeof rename;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
}

/** Atomically replace a baseline through a same-directory temporary file. */
export async function writeBaselineAtomic(
  path: string,
  document: BaselineDocument,
  overrides: Partial<BaselineWriteOperations> = {},
): Promise<void> {
  const operations: BaselineWriteOperations = { rename, unlink, writeFile, ...overrides };
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    await operations.writeFile(temporary, serializeBaseline(document), { flag: 'wx' });
    temporaryExists = true;
    await operations.rename(temporary, path);
    temporaryExists = false;
  } finally {
    if (temporaryExists) await operations.unlink(temporary).catch(() => {});
  }
}
