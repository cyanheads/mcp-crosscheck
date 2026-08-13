/** @file src/redact.ts Exact-value redaction for crosscheck-owned diagnostics and reports. */

const REDACTED = '[REDACTED]';
const reportRedactors = new WeakMap<object, (text: string) => string>();

/** Build a deterministic exact-string redactor from configured secret values. */
export function createRedactor(values: string[]): (text: string) => string {
  const secrets = [...new Set(values.filter((value) => value !== ''))].sort(
    (left, right) => right.length - left.length,
  );
  return (text) => secrets.reduce((current, secret) => current.replaceAll(secret, REDACTED), text);
}

/** Recursively redact every string leaf before crosscheck serializes a report. */
export function redactValue<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redact)) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactValue(entry, redact)]),
  ) as T;
}

/** Associate a completed report with its final serialization safeguard. */
export function registerReportRedactor(report: object, redact: (text: string) => string): void {
  reportRedactors.set(report, redact);
}

/** Apply the final report safeguard without persisting secret values on the report object. */
export function redactReport<T extends object>(report: T): T {
  const redact = reportRedactors.get(report);
  return redact === undefined ? report : redactValue(report, redact);
}
