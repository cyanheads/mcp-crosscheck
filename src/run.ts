/**
 * @file src/run.ts
 * Orchestration: capture ground truth, preflight the canary against it, run
 * each selected adapter hermetically, and assemble the final report.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ADAPTERS } from './adapters/index.js';
import { captureGroundTruth, runGroundTruthCanary } from './ground-truth.js';
import { buildFindings } from './invariants.js';
import type { AdapterName, AdapterReport, CanarySpec, RunReport, TargetSpec } from './types.js';
import { VERSION } from './version.js';

/** Raised for caller mistakes (bad flags, bad canary spec) — CLI exit code 2. */
export class CrosscheckUsageError extends Error {}

export interface CrosscheckOptions {
  adapters: AdapterName[];
  /** Directory to persist raw captures into; created if missing. */
  artifactsDir?: string | null;
  canary?: CanarySpec | null;
  log?: (line: string) => void;
  /** Extra `uvx --with` dependency constraints for mcpo (e.g. `mcp<2`). */
  mcpoWith?: string[];
  /** Adapter name → exact version, overriding the latest-floats default. */
  pins?: Partial<Record<AdapterName, string>>;
  target: TargetSpec;
  /** Per-stage timeout in milliseconds. */
  timeoutMs?: number;
}

/** Run the full crosscheck: ground truth, canary preflight, every selected adapter. */
export async function runCrosscheck(options: CrosscheckOptions): Promise<RunReport> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 120_000;
  const canary = options.canary ?? null;
  const artifactsDir = options.artifactsDir ?? null;

  for (const name of options.adapters) {
    const verdict = ADAPTERS[name].supports(options.target);
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
    const groundTruth = await captureGroundTruth(options.target, timeoutMs);
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
      groundTruthCanary = await runGroundTruthCanary(options.target, canary, timeoutMs);
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
        log,
        mcpoWith: options.mcpoWith ?? [],
        pins: options.pins ?? {},
        target: options.target,
        timeoutMs,
        workDir,
      });
      adapterReports.push({
        adapter: result.adapter,
        canary: result.canary,
        durationMs: result.durationMs,
        findings: buildFindings(groundTruth.tools, result),
        resolvedVersion: result.resolvedVersion,
        status: result.status,
        statusDetail: result.statusDetail,
        toolCount: result.surface === null ? null : result.surface.tools.length,
      });
    }

    const allFindings = adapterReports.flatMap((adapter) => adapter.findings);
    const failCount = allFindings.filter((finding) => finding.severity === 'fail').length;
    const infoCount = allFindings.filter((finding) => finding.severity === 'info').length;

    const target: RunReport['target'] =
      options.target.kind === 'http'
        ? { kind: 'http', url: options.target.url }
        : { args: options.target.args, command: options.target.command, kind: 'stdio' };

    return {
      adapters: adapterReports,
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
      target,
    };
  } finally {
    await rm(workDir, { force: true, recursive: true }).catch(() => {
      /* scratch dir cleanup is best-effort */
    });
  }
}
