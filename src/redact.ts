/**
 * @file src/redact.ts
 * Exact-value redaction of the free text in crosscheck-owned diagnostics and
 * reports. Only prose is rewritten: a header value such as `on` or `1` also
 * occurs inside rule ids, paths, and versions, and rewriting those would break
 * the machine contract and every baseline written from it.
 */
import type { CanaryOutcome, Finding, RunReport } from './types.js';

type Redact = (text: string) => string;

/** The marker that replaces each header value. */
export const REDACTED = '[REDACTED]';
const reportRedactors = new WeakMap<object, Redact>();

/**
 * Build a deterministic exact-string redactor from configured secret values.
 * All values are replaced in one regex pass, longest first, so a value inside
 * the marker (`RED`, `D`) never rewrites a marker the pass just wrote. Text is
 * split on existing markers first, which makes a repeat pass a no-op.
 */
export function createRedactor(values: string[]): Redact {
  const secrets = [...new Set(values.filter((value) => value !== ''))].sort(
    (left, right) => right.length - left.length,
  );
  if (secrets.length === 0) return (text) => text;
  const pattern = new RegExp(
    secrets.map((secret) => secret.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|'),
    'g',
  );
  return (text) =>
    text
      .split(REDACTED)
      .map((segment) => segment.replace(pattern, REDACTED))
      .join(REDACTED);
}

function redactCanary(canary: CanaryOutcome | null, redact: Redact): CanaryOutcome | null {
  if (canary === null || canary.detail === null) return canary;
  return { ...canary, detail: redact(canary.detail) };
}

/**
 * Redact a report's free text: every finding `detail` (the ground-truth notes
 * included), each adapter's `statusDetail`, and every canary `detail`. Rule
 * ids, severities, paths, evidence, tool and server names, the target, and
 * versions are structured fields and keep their values.
 */
export function redactRunReport(report: RunReport, redact: Redact): RunReport {
  const findings = <T extends Finding>(list: T[]): T[] =>
    list.map((finding) => ({ ...finding, detail: redact(finding.detail) }));
  return {
    ...report,
    adapters: report.adapters.map((adapter) => ({
      ...adapter,
      acknowledgedFindings: findings(adapter.acknowledgedFindings),
      canary: redactCanary(adapter.canary, redact),
      findings: findings(adapter.findings),
      newFindings: findings(adapter.newFindings),
      statusDetail: adapter.statusDetail === null ? null : redact(adapter.statusDetail),
    })),
    groundTruth: {
      ...report.groundTruth,
      canary: redactCanary(report.groundTruth.canary, redact),
      findings: findings(report.groundTruth.findings),
    },
  };
}

/** Associate a completed report with its final serialization safeguard. */
export function registerReportRedactor(report: object, redact: Redact): void {
  reportRedactors.set(report, redact);
}

/** Apply the final report safeguard without persisting secret values on the report object. */
export function redactReport(report: RunReport): RunReport {
  const redact = reportRedactors.get(report);
  return redact === undefined ? report : redactRunReport(report, redact);
}
