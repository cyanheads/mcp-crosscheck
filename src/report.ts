/**
 * @file src/report.ts
 * Report rendering: a colorized human table on stdout, or the stable `--json`
 * shape for scripted consumers. Progress logging stays on stderr either way.
 */
import { styleText } from 'node:util';

import { redactReport } from './redact.js';
import type { AdapterReport, Finding, RunReport } from './types.js';

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

  lines.push(
    `${paint('bold', `mcp-crosscheck v${report.crosscheckVersion}`)} ${paint('dim', '→')} ${serverLabel} ${paint(
      'dim',
      `(${report.groundTruth.toolCount} tools advertised)`,
    )}`,
  );
  lines.push('');

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
        `FAIL — ${report.failCount} new failure(s), ${report.infoCount} new info note(s), ${report.acknowledgedCount} acknowledged, ${report.staleCount} stale across ${report.adapters.length} adapter(s)`,
      );
  lines.push(summary);
  return lines.join('\n');
}

/** The stable machine-readable shape emitted by `--json`. */
export function toJsonReport(report: RunReport): string {
  return JSON.stringify(redactReport(report), null, 2);
}
