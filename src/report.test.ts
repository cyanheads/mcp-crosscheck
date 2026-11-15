/**
 * @file src/report.test.ts
 * Both report surfaces — the human table and the `--json` document — for a
 * capture failure and a renamed tool, built from the engine's own findings.
 */
import { describe, expect, test } from 'bun:test';
import { stripVTControlCharacters } from 'node:util';

import { buildFindings } from './invariants.js';
import { renderHumanReport, toJsonReport } from './report.js';
import { renderedToolFromJsonSchema } from './schema.js';
import type {
  AdapterReport,
  AdapterRunResult,
  GroundTruthTool,
  RunReport,
  ToolRenameMap,
} from './types.js';

const filesRead: GroundTruthTool = {
  description: 'Read files.',
  inputSchema: { properties: { path: { type: 'string' } }, type: 'object' },
  name: 'files.read',
};

/** One adapter's report slice, assembled from a run result the way `runCrosscheck` does. */
function adapterReport(result: AdapterRunResult, renames?: ToolRenameMap): AdapterReport {
  const findings = buildFindings([filesRead], result, renames);
  return {
    acknowledgedFindings: [],
    adapter: result.adapter,
    canary: result.canary,
    durationMs: result.durationMs,
    findings,
    newFindings: findings,
    resolvedVersion: result.resolvedVersion,
    status: result.status,
    statusDetail: result.statusDetail,
    toolCount: result.surface === null ? null : result.surface.tools.length,
  };
}

function runReport(adapters: AdapterReport[]): RunReport {
  const findings = adapters.flatMap((adapter) => adapter.newFindings);
  const failCount = findings.filter((finding) => finding.severity === 'fail').length;
  return {
    acknowledgedCount: 0,
    adapters,
    baselineDiagnostics: [],
    crosscheckVersion: '0.0.0-test',
    failCount,
    groundTruth: {
      canary: null,
      depthLimitedPaths: [],
      findings: [],
      serverName: 'fixture',
      serverVersion: '1.0.0',
      toolCount: 1,
      toolNames: [filesRead.name],
      truncation: null,
    },
    infoCount: findings.length - failCount,
    pass: failCount === 0,
    reportVersion: 1,
    staleCount: 0,
    target: { args: ['server.js'], command: 'node', kind: 'stdio' },
  };
}

const CAPTURE_DETAIL = 'tools/list output exceeded the capture limit (2097152 bytes captured)';

const report = runReport([
  adapterReport({
    adapter: 'inspector',
    canary: null,
    durationMs: 1200,
    resolvedVersion: '2.8.0',
    status: 'capture-failure',
    statusDetail: CAPTURE_DETAIL,
    surface: null,
  }),
  adapterReport(
    {
      adapter: 'claude-code',
      canary: { attempted: false, detail: 'claude-code adapter is capture-only', ok: null },
      durationMs: 800,
      resolvedVersion: '2.1.325',
      status: 'ok',
      statusDetail: null,
      surface: {
        tools: [renderedToolFromJsonSchema('files_read', 'Read files.', filesRead.inputSchema)],
      },
    },
    new Map([['files.read', { change: 'sanitized', kind: 'renamed', rendered: 'files_read' }]]),
  ),
]);

describe('capture failures and renamed tools in both report surfaces', () => {
  test('the human report fails the capture and records the rename as info', () => {
    const lines = stripVTControlCharacters(renderHumanReport(report)).split('\n');
    expect(lines).toContain('inspector (v2.8.0, 1.2s) 1 FAIL');
    expect(lines).toContain(
      `  FAIL [capture-failure] client output could not be captured — ${CAPTURE_DETAIL}`,
    );
    expect(lines.filter((line) => line.includes('rendered '))).toEqual(['  rendered 1/1 tools']);
    expect(lines).toContain('claude-code (v2.1.325, 0.8s) PASS');
    expect(lines).toContain(
      '  info [tool-renamed] files.read tool name was sanitized in rendering — the client renders it as "files_read"',
    );
    expect(lines.at(-1)).toBe(
      'FAIL — 1 new failure(s), 1 new info note(s), 0 acknowledged, 0 stale across 2 adapter(s)',
    );
  });

  test('the JSON report carries the status, a null tool count, and both findings’ evidence', () => {
    const json = JSON.parse(toJsonReport(report)) as RunReport;
    expect(json.reportVersion).toBe(1);
    expect(json.pass).toBe(false);
    expect([json.failCount, json.infoCount]).toEqual([1, 1]);
    expect(
      json.adapters.map((adapter) => [adapter.adapter, adapter.status, adapter.toolCount]),
    ).toEqual([
      ['inspector', 'capture-failure', null],
      ['claude-code', 'ok', 1],
    ]);
    expect(json.adapters.map((adapter) => adapter.newFindings)).toEqual([
      [
        {
          detail: `client output could not be captured — ${CAPTURE_DETAIL}`,
          evidence: { kind: 'capture-failure' },
          path: null,
          rule: 'capture-failure',
          severity: 'fail',
        },
      ],
      [
        {
          detail: 'tool name was sanitized in rendering — the client renders it as "files_read"',
          evidence: { change: 'sanitized', kind: 'tool-renamed' },
          path: 'files.read',
          rule: 'tool-renamed',
          severity: 'info',
        },
      ],
    ]);
  });
});
