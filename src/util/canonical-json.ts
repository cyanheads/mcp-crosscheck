/**
 * @file src/util/canonical-json.ts
 * Canonical JSON: object keys sorted at every depth, so two values that differ
 * only in key order serialize identically. Array order is preserved.
 */

/** Rebuild a JSON value with every object's keys in sorted order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

/** Serialize a JSON value canonically, for equality comparison. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
