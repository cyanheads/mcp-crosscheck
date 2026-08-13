/**
 * @file src/run.ts
 * Orchestration: capture ground truth, preflight the canary against it, run
 * each selected adapter hermetically, and assemble the final report.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ADAPTERS } from './adapters/index.js';
import {
  BaselineValidationError,
  parseBaseline,
  reconcileBaseline,
  updateBaseline,
  writeBaselineAtomic,
} from './baseline.js';
import { validateHttpHeaders } from './cli-args.js';
import { captureGroundTruth, runGroundTruthCanary } from './ground-truth.js';
import { buildFindings } from './invariants.js';
import { createRedactor, redactValue, registerReportRedactor } from './redact.js';
import { canonicalizeTarget } from './target.js';
import type {
  AdapterName,
  AdapterReport,
  BaselineDocument,
  CanarySpec,
  RunReport,
  TargetSpec,
} from './types.js';
import type { Exec } from './util/exec.js';
import { VERSION } from './version.js';

/** Raised for caller mistakes (bad flags, bad canary spec) — CLI exit code 2. */
export class CrosscheckUsageError extends Error {}

export interface CrosscheckOptions {
  adapters: AdapterName[];
  /** Directory to persist raw captures into; created if missing. */
  artifactsDir?: string | null;
  /** Compatibility baseline path, read-only unless `updateBaseline` is true. */
  baselinePath?: string | null;
  canary?: CanarySpec | null;
  /** Process seam passed to selected adapters; omitted runs real child processes. */
  exec?: Exec;
  log?: (line: string) => void;
  /** Extra `uvx --with` dependency constraints for mcpo (e.g. `mcp<2`). */
  mcpoWith?: string[];
  /** Adapter name → exact version, overriding the latest-floats default. */
  pins?: Partial<Record<AdapterName, string>>;
  target: TargetSpec;
  /** Per-stage timeout in milliseconds. */
  timeoutMs?: number;
  updateBaseline?: boolean;
}

const GENERATED_ARTIFACT_NAMES = [
  'claude-code.request.json',
  'codex.request.json',
  'ground-truth.json',
  'mcpo.openapi.json',
  'report.json',
] as const;

/** Run the full crosscheck: ground truth, canary preflight, every selected adapter. */
export async function runCrosscheck(options: CrosscheckOptions): Promise<RunReport> {
  const canonicalTarget = canonicalizeTarget(options.target, process.cwd());
  let target: TargetSpec;
  try {
    target =
      canonicalTarget.kind === 'http'
        ? {
            headers: validateHttpHeaders(canonicalTarget.headers ?? {}),
            kind: 'http',
            url: canonicalTarget.url,
          }
        : canonicalTarget;
  } catch (error) {
    throw new CrosscheckUsageError(error instanceof Error ? error.message : String(error));
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  const canary = options.canary ?? null;
  const artifactsDir =
    options.artifactsDir === undefined || options.artifactsDir === null
      ? null
      : resolve(options.artifactsDir);
  const baselinePath =
    options.baselinePath === undefined || options.baselinePath === null
      ? null
      : resolve(options.baselinePath);
  const updateRequested = options.updateBaseline ?? false;
  if (updateRequested && baselinePath === null) {
    throw new CrosscheckUsageError('updateBaseline requires baselinePath');
  }
  const aliasedArtifactName =
    baselinePath === null || artifactsDir === null
      ? undefined
      : GENERATED_ARTIFACT_NAMES.find((name) => resolve(artifactsDir, name) === baselinePath);
  if (aliasedArtifactName !== undefined) {
    throw new CrosscheckUsageError(
      `baseline path must not alias the generated ${aliasedArtifactName} artifact`,
    );
  }
  const redact = createRedactor(target.kind === 'http' ? Object.values(target.headers ?? {}) : []);
  const writeLog = options.log ?? (() => {});
  const log = (line: string) => writeLog(redact(line));

  let baseline: BaselineDocument = { baselineVersion: 1, entries: [] };
  if (baselinePath !== null) {
    try {
      baseline = parseBaseline(await readFile(baselinePath, 'utf8'));
    } catch (error) {
      if (updateRequested && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        baseline = { baselineVersion: 1, entries: [] };
      } else if (error instanceof BaselineValidationError) {
        throw new CrosscheckUsageError(`${baselinePath}: ${error.message}`);
      } else if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new CrosscheckUsageError(`baseline file does not exist: ${baselinePath}`);
      } else {
        throw error;
      }
    }
  }

  for (const name of options.adapters) {
    const verdict = ADAPTERS[name].supports(target);
    if (verdict !== true) {
      throw new CrosscheckUsageError(`adapter "${name}": ${verdict}`);
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), 'mcp-crosscheck-'));
  if (artifactsDir !== null) {
    await mkdir(artifactsDir, { recursive: true });
  }

  try {
    log('capturing ground truth via the official MCP SDK client');
    const groundTruth = await captureGroundTruth(target, timeoutMs);
    log(
      `ground truth: ${groundTruth.serverName ?? 'unnamed server'} advertises ${groundTruth.tools.length} tool(s)`,
    );
    if (artifactsDir !== null) {
      await writeFile(
        join(artifactsDir, 'ground-truth.json'),
        JSON.stringify(groundTruth, null, 2),
      );
    }

    let groundTruthCanary = null;
    if (canary !== null) {
      if (!groundTruth.tools.some((tool) => tool.name === canary.tool)) {
        throw new CrosscheckUsageError(
          `canary tool "${canary.tool}" is not advertised by the server`,
        );
      }
      groundTruthCanary = redactValue(
        await runGroundTruthCanary(target, canary, timeoutMs),
        redact,
      );
      if (groundTruthCanary.ok !== true) {
        throw new CrosscheckUsageError(
          `canary failed against ground truth — fix the canary spec before blaming a client${
            groundTruthCanary.detail === null ? '' : ` (${groundTruthCanary.detail})`
          }`,
        );
      }
      log(`canary ${canary.tool} verified against ground truth`);
    }

    const adapterReports: AdapterReport[] = [];
    for (const name of options.adapters) {
      log(`running adapter: ${name}`);
      const result = await ADAPTERS[name].run({
        artifactsDir,
        canary,
        ...(options.exec === undefined ? {} : { exec: options.exec }),
        log,
        mcpoWith: options.mcpoWith ?? [],
        pins: options.pins ?? {},
        redact,
        target,
        timeoutMs,
        workDir,
      });
      const findings = redactValue(buildFindings(groundTruth.tools, result), redact);
      adapterReports.push({
        acknowledgedFindings: [],
        adapter: result.adapter,
        canary: redactValue(result.canary, redact),
        durationMs: result.durationMs,
        findings,
        newFindings: findings,
        resolvedVersion: result.resolvedVersion,
        status: result.status,
        statusDetail: result.statusDetail === null ? null : redact(result.statusDetail),
        toolCount: result.surface === null ? null : result.surface.tools.length,
      });
    }

    const states = adapterReports.map((adapter) => ({
      adapter: adapter.adapter,
      comparisonSucceeded: adapter.status === 'ok' && adapter.toolCount !== null,
      findings: adapter.findings,
    }));
    const eligibleForUpdate = states.every(
      (state) =>
        state.comparisonSucceeded &&
        !state.findings.some(
          (finding) =>
            finding.rule === 'adapter-broken' ||
            finding.rule === 'handshake-failure' ||
            finding.rule === 'canary-failed',
        ),
    );
    if (updateRequested && baselinePath !== null && eligibleForUpdate) {
      baseline = updateBaseline(baseline, states);
      await writeBaselineAtomic(baselinePath, baseline);
    }
    const reconciliation = reconcileBaseline(baseline, states);
    for (const adapter of adapterReports) {
      const reconciled = reconciliation.adapters.find((entry) => entry.adapter === adapter.adapter);
      adapter.newFindings = reconciled?.newFindings ?? adapter.findings;
      adapter.acknowledgedFindings = reconciled?.acknowledgedFindings ?? [];
    }

    const allFindings = adapterReports.flatMap((adapter) => adapter.newFindings);
    const failCount = allFindings.filter((finding) => finding.severity === 'fail').length;
    const infoCount = allFindings.filter((finding) => finding.severity === 'info').length;

    const reportTarget: RunReport['target'] =
      target.kind === 'http'
        ? { kind: 'http', url: target.url }
        : { args: target.args, command: target.command, kind: 'stdio' };

    const report: RunReport = {
      acknowledgedCount: adapterReports.reduce(
        (count, adapter) => count + adapter.acknowledgedFindings.length,
        0,
      ),
      adapters: adapterReports,
      baselineDiagnostics: reconciliation.baselineDiagnostics,
      crosscheckVersion: VERSION,
      failCount,
      groundTruth: {
        canary: groundTruthCanary,
        serverName: groundTruth.serverName,
        serverVersion: groundTruth.serverVersion,
        toolCount: groundTruth.tools.length,
        toolNames: groundTruth.tools.map((tool) => tool.name),
      },
      infoCount,
      pass: failCount === 0,
      staleCount: reconciliation.baselineDiagnostics.length,
      target: reportTarget,
    };
    const safeReport = redactValue(report, redact);
    registerReportRedactor(safeReport, redact);
    return safeReport;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    if (error instanceof CrosscheckUsageError) throw new CrosscheckUsageError(message);
    throw new Error(message);
  } finally {
    await rm(workDir, { force: true, recursive: true }).catch(() => {
      /* scratch dir cleanup is best-effort */
    });
  }
}
