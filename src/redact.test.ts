/** @file src/redact.test.ts Exact header-value redaction through status and report outputs. */
import { expect, test } from 'bun:test';
import { createRedactor, registerReportRedactor } from './redact.js';
import { renderHumanReport, toJsonReport } from './report.js';
import type { Finding, GroundTruthFinding, RunReport } from './types.js';

/** A one-adapter report whose ground-truth block takes `groundTruth` over empty defaults. */
function reportWith(adapterFindings: Finding[], groundTruth: Partial<RunReport['groundTruth']>) {
  const report: RunReport = {
    acknowledgedCount: 0,
    adapters: [
      {
        acknowledgedFindings: [],
        adapter: 'inspector',
        canary: null,
        durationMs: 1,
        findings: adapterFindings,
        newFindings: adapterFindings,
        resolvedVersion: '2.1.0',
        status: 'ok',
        statusDetail: null,
        toolCount: 1,
      },
    ],
    baselineDiagnostics: [],
    crosscheckVersion: '0.1.0',
    failCount: adapterFindings.filter((finding) => finding.severity === 'fail').length,
    groundTruth: {
      canary: null,
      depthLimitedPaths: [],
      findings: [],
      serverName: null,
      serverVersion: null,
      toolCount: 0,
      toolNames: [],
      truncation: null,
      ...groundTruth,
    },
    infoCount: 0,
    pass: false,
    reportVersion: 1,
    staleCount: 0,
    target: { kind: 'http', url: 'http://127.0.0.1/mcp' },
  };
  return report;
}

test('redacts exact configured values, longest first', () => {
  const redact = createRedactor(['secret', 'secret-long']);
  expect(redact('secret-long then secret')).toBe('[REDACTED] then [REDACTED]');
});

test('never rewrites its own marker, so a value inside it cannot nest markers', () => {
  const redact = createRedactor(['RED', 'ACT']);
  const once = redact('RED then ACT');
  expect(once).toBe('[REDACTED] then [REDACTED]');
  expect(redact(once)).toBe(once);
  expect(redact(redact(once))).toBe(once);
});

test('matches configured values literally, not as patterns', () => {
  expect(createRedactor(['a.b', '(x'])('a.b axb (x')).toBe('[REDACTED] axb [REDACTED]');
});

test('ignores empty configured values instead of corrupting every string boundary', () => {
  expect(createRedactor([''])('unchanged')).toBe('unchanged');
  expect(createRedactor(['', 'secret'])('secret stays bounded')).toBe('[REDACTED] stays bounded');
});

test('human and JSON report serialization apply the final redaction safeguard', () => {
  const secret = 'fixture-secret';
  const failure: Finding = {
    detail: `controlled rejection: ${secret}`,
    evidence: { kind: 'handshake-failure' },
    path: null,
    rule: 'handshake-failure',
    severity: 'fail',
  };
  const report = reportWith([failure], {
    canary: { attempted: true, detail: `canary answered ${secret}`, ok: true },
  });
  const [adapter] = report.adapters;
  if (adapter === undefined) throw new Error('report lost its adapter');
  adapter.canary = { attempted: true, detail: `rejected ${secret}`, ok: false };
  adapter.status = 'handshake-failure';
  adapter.statusDetail = `controlled rejection: ${secret}`;
  registerReportRedactor(report, createRedactor([secret]));
  expect(toJsonReport(report)).not.toContain(secret);
  expect(renderHumanReport(report)).not.toContain(secret);
  expect(toJsonReport(report)).toContain('[REDACTED]');
});

test('redaction rewrites free text only, the ground-truth block included', () => {
  // `on` occurs in rule ids, evidence, paths, names, and the dialect URI.
  const lost: Finding = {
    detail: 'property description was lost in rendering',
    evidence: { kind: 'description-lost', subject: 'property' },
    path: 'on_tool.option',
    rule: 'description-lost',
    severity: 'fail',
  };
  const note: GroundTruthFinding = {
    detail: 'input schema declares the JSON Schema dialect https://on.example/schema',
    evidence: { declared: 'https://on.example/schema', kind: 'unsupported-dialect' },
    path: 'on_tool',
    rule: 'unsupported-dialect',
    severity: 'info',
  };
  const report = reportWith([lost], {
    depthLimitedPaths: ['on_tool.option.a.b.c.d.e'],
    findings: [note],
    serverName: 'json-server',
    toolNames: ['on_tool'],
  });
  registerReportRedactor(report, createRedactor(['on']));

  const json = JSON.parse(toJsonReport(report)) as RunReport;
  expect(json.adapters[0]?.findings).toEqual([
    { ...lost, detail: 'property descripti[REDACTED] was lost in rendering' },
  ]);
  expect(json.groundTruth).toEqual({
    ...report.groundTruth,
    findings: [
      {
        ...note,
        detail: 'input schema declares the JSON Schema dialect https://[REDACTED].example/schema',
      },
    ],
  });
  expect(json.target).toEqual(report.target);

  const human = renderHumanReport(report);
  expect(human).toContain('[description-lost] on_tool.option');
  expect(human).toContain('[unsupported-dialect] on_tool');
  expect(human).toContain('on_tool.option.a.b.c.d.e');
  expect(human).toContain('json-server@');
});
