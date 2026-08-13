/** @file src/redact.test.ts Exact header-value redaction through status and report outputs. */
import { expect, test } from 'bun:test';
import { createRedactor, redactValue, registerReportRedactor } from './redact.js';
import { renderHumanReport, toJsonReport } from './report.js';
import type { RunReport } from './types.js';

test('redacts exact configured values recursively, longest first', () => {
  const redact = createRedactor(['secret', 'secret-long']);
  expect(redactValue({ detail: 'secret-long then secret', nested: ['secret'] }, redact)).toEqual({
    detail: '[REDACTED] then [REDACTED]',
    nested: ['[REDACTED]'],
  });
});

test('ignores empty configured values instead of corrupting every string boundary', () => {
  expect(createRedactor([''])('unchanged')).toBe('unchanged');
  expect(createRedactor(['', 'secret'])('secret stays bounded')).toBe('[REDACTED] stays bounded');
});

test('human and JSON report serialization apply the final redaction safeguard', () => {
  const secret = 'fixture-secret';
  const report: RunReport = {
    acknowledgedCount: 0,
    adapters: [
      {
        acknowledgedFindings: [],
        adapter: 'inspector',
        canary: null,
        durationMs: 1,
        findings: [
          {
            detail: `controlled rejection: ${secret}`,
            evidence: { kind: 'handshake-failure' },
            path: null,
            rule: 'handshake-failure',
            severity: 'fail',
          },
        ],
        newFindings: [
          {
            detail: `controlled rejection: ${secret}`,
            evidence: { kind: 'handshake-failure' },
            path: null,
            rule: 'handshake-failure',
            severity: 'fail',
          },
        ],
        resolvedVersion: '2.1.0',
        status: 'handshake-failure',
        statusDetail: `controlled rejection: ${secret}`,
        toolCount: null,
      },
    ],
    baselineDiagnostics: [],
    crosscheckVersion: '0.0.3',
    failCount: 1,
    groundTruth: {
      canary: null,
      serverName: null,
      serverVersion: null,
      toolCount: 0,
      toolNames: [],
    },
    infoCount: 0,
    pass: false,
    staleCount: 0,
    target: { kind: 'http', url: 'http://127.0.0.1/mcp' },
  };
  registerReportRedactor(report, createRedactor([secret]));
  expect(toJsonReport(report)).not.toContain(secret);
  expect(renderHumanReport(report)).not.toContain(secret);
  expect(toJsonReport(report)).toContain('[REDACTED]');
});
