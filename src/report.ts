/**
 * @file src/report.ts
 * Report rendering: a colorized human table on stdout, or the stable `--json`
 * shape for scripted consumers. Progress logging stays on stderr either way.
 */
import { styleText } from 'node:util';

import { redactReport } from './redact.js';
import type {
  AdapterReport,
  ErrorReport,
  Finding,
  GroundTruthTruncation,
  RunReport,
} from './types.js';

const TRUNCATION_REASONS: Record<GroundTruthTruncation['reason'], string> = {
  'cursor-repeated': 'the server repeated a cursor',
  'page-cap': 'the page cap was reached with a nextCursor still in hand',
};

/** Why an incomplete `tools/list` walk stopped, with its page count. */
export function truncationNote(truncation: GroundTruthTruncation): string {
  return `tools/list stopped after ${truncation.pagesRead} page(s): ${TRUNCATION_REASONS[truncation.reason]}`;
}

function paint(format: Parameters<typeof styleText>[0], text: string): string {
  return styleText(format, text, { validateStream: true });
}

function severityTag(finding: Finding): string {
  return finding.severity === 'fail' ? paint(['red', 'bold'], 'FAIL') : paint('yellow', 'info');
}

function adapterHeadline(adapter: AdapterReport): string {
  const version =
    adapter.resolvedVersion === null ? 'version unresolved' : `v${adapter.resolvedVersion}`;
  const seconds = (adapter.durationMs / 1000).toFixed(1);
  const failCount = adapter.newFindings.filter((finding) => finding.severity === 'fail').length;
  const verdict =
    failCount === 0
      ? paint(['green', 'bold'], 'PASS')
      : paint(['red', 'bold'], `${failCount} FAIL`);
  return `${paint('bold', adapter.adapter)} ${paint('dim', `(${version}, ${seconds}s)`)} ${verdict}`;
}

function renderFinding(finding: Finding): string {
  const scope = finding.path === null ? '' : `${paint('cyan', finding.path)} `;
  return `  ${severityTag(finding)} ${paint('dim', `[${finding.rule}]`)} ${scope}${finding.detail}`;
}

function renderCanaryLine(adapter: AdapterReport): string | null {
  if (adapter.canary === null) return null;
  if (!adapter.canary.attempted) {
    return `  ${paint('dim', `canary: skipped — ${adapter.canary.detail ?? 'not supported'}`)}`;
  }
  if (adapter.canary.ok === true) {
    return `  ${paint('green', 'canary: round-trip ok')}`;
  }
  return null; // failures already surface as a canary-failed finding
}

/** Render the full human-readable report. */
export function renderHumanReport(input: RunReport): string {
  const report = redactReport(input);
  const lines: string[] = [];
  const targetLabel =
    report.target.kind === 'http'
      ? report.target.url
      : [report.target.command, ...report.target.args].join(' ');
  const serverLabel =
    report.groundTruth.serverName === null
      ? targetLabel
      : `${report.groundTruth.serverName}@${report.groundTruth.serverVersion ?? '?'}`;
  const { truncation } = report.groundTruth;
  const truncated = truncation === null ? '' : truncationNote(truncation);

  lines.push(
    `${paint('bold', `mcp-crosscheck v${report.crosscheckVersion}`)} ${paint('dim', '→')} ${serverLabel} ${paint(
      'dim',
      `(${report.groundTruth.toolCount} tools advertised)`,
    )}${truncated === '' ? '' : ` ${paint(['red', 'bold'], truncated)}`}`,
  );
  lines.push('');

  const { depthLimitedPaths, findings } = report.groundTruth;
  if (findings.length > 0 || depthLimitedPaths.length > 0) {
    lines.push(paint('bold', 'Ground truth'));
    for (const finding of findings) lines.push(renderFinding(finding));
    for (const path of depthLimitedPaths) {
      lines.push(
        `  ${paint('dim', 'depth limit')} ${paint('cyan', path)} — the fields below it were not compared`,
      );
    }
    lines.push('');
  }

  for (const adapter of report.adapters) {
    lines.push(adapterHeadline(adapter));
    if (adapter.toolCount !== null) {
      lines.push(
        `  ${paint('dim', `rendered ${adapter.toolCount}/${report.groundTruth.toolCount} tools`)}`,
      );
    }
    const canaryLine = renderCanaryLine(adapter);
    if (canaryLine !== null) lines.push(canaryLine);
    const ordered = [...adapter.newFindings].sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === 'fail' ? -1 : 1,
    );
    for (const finding of ordered) {
      lines.push(renderFinding(finding));
    }
    if (adapter.newFindings.length === 0 && adapter.acknowledgedFindings.length === 0) {
      lines.push(`  ${paint('dim', 'no divergence from ground truth')}`);
    }
    if (adapter.acknowledgedFindings.length > 0) {
      lines.push(
        `  ${paint('dim', `${adapter.acknowledgedFindings.length} acknowledged finding(s) (see JSON for details)`)}`,
      );
    }
    lines.push('');
  }

  if (report.baselineDiagnostics.length > 0) {
    lines.push(paint('bold', 'Baseline diagnostics'));
    for (const diagnostic of report.baselineDiagnostics) {
      lines.push(
        `  ${paint('yellow', 'info')} ${diagnostic.adapter} stale ${diagnostic.entry.rule} ${paint('cyan', diagnostic.entry.path)}`,
      );
    }
    lines.push('');
  }

  const summary = report.pass
    ? paint(
        ['green', 'bold'],
        `PASS — ${report.adapters.length} adapter(s), ${report.infoCount} new info note(s), ${report.acknowledgedCount} acknowledged, ${report.staleCount} stale`,
      )
    : paint(
        ['red', 'bold'],
        `FAIL — ${truncated === '' ? '' : `${truncated}; `}${report.failCount} new failure(s), ${report.infoCount} new info note(s), ${report.acknowledgedCount} acknowledged, ${report.staleCount} stale across ${report.adapters.length} adapter(s)`,
      );
  lines.push(summary);
  return lines.join('\n');
}

/** The stable machine-readable shape emitted by `--json`. */
export function toJsonReport(report: RunReport): string {
  return JSON.stringify(redactReport(report), null, 2);
}

/** The `--json` document for a run that ended without a report; `message` must already be redacted. */
export function toJsonError(kind: ErrorReport['error']['kind'], message: string): string {
  const document: ErrorReport = { error: { kind, message }, reportVersion: 1 };
  return JSON.stringify(document, null, 2);
}
