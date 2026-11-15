/**
 * @file src/run.ts
 * Orchestration: capture ground truth, preflight the canary against it, run
 * each selected adapter hermetically, and assemble the final report. Every
 * client starts a stdio target through the launcher (src/launch-target.ts),
 * which starts it exactly as ground truth does.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTERS, isAdapterName } from './adapters/index.js';
import {
  BaselineValidationError,
  parseBaseline,
  RUNTIME_RULES,
  reconcileBaseline,
  updateBaseline,
  writeBaselineAtomic,
} from './baseline.js';
import { validateHttpHeaders } from './cli-args.js';
import { captureGroundTruth, runGroundTruthCanary } from './ground-truth.js';
import {
  buildFindings,
  depthLimitedPaths,
  groundTruthFindings,
  pairEmptyCapture,
} from './invariants.js';
import {
  createRedactor,
  redactRunReport,
  registerReportRedactor,
  targetRedactor,
} from './redact.js';
import { truncationNote } from './report.js';
import { targetLaunch } from './target.js';
import type {
  AdapterName,
  AdapterReport,
  AdapterTarget,
  BaselineDocument,
  CanarySpec,
  RunReport,
  TargetSpec,
} from './types.js';
import type { Exec } from './util/exec.js';
import { VERSION } from './version.js';

/**
 * Raised for caller mistakes (bad flags, bad canary spec) and for a canary
 * that fails its ground-truth preflight, whichever side is at fault — CLI exit code 2.
 */
export class CrosscheckUsageError extends Error {}

/**
 * Longest delay a Node timer honors. A longer one fires after 1 ms with a
 * TimeoutOverflowWarning, which would time out every stage at once.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export interface CrosscheckOptions {
  /** Adapters to run, in this order; each name at most once. */
  adapters: AdapterName[];
  /** Directory to persist raw captures into; created if missing. */
  artifactsDir?: string | null;
  /** Compatibility baseline path, read-only unless `updateBaseline` is true. */
  baselinePath?: string | null;
  canary?: CanarySpec | null;
  /** Process seam passed to selected adapters; omitted runs real child processes. */
  exec?: Exec;
  log?: (line: string) => void;
  /**
   * Extra `uvx --with` requirements for mcpo. An entry naming `mcp` or
   * `fastapi` replaces that package's default constraint (`mcp<2`,
   * `fastapi<0.145`); any other entry is added alongside them.
   */
  mcpoWith?: string[];
  /** Adapter name → exact version, overriding the latest-floats default. */
  pins?: Partial<Record<AdapterName, string>>;
  target: TargetSpec;
  /** Per-stage timeout in milliseconds, from 1 to `MAX_TIMEOUT_MS`. Default: 120000. */
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

const MODULE_PATH = fileURLToPath(import.meta.url);
/**
 * The launcher, beside this module with its extension: `launch-target.js` when
 * built, `launch-target.ts` when Bun runs the sources and is `process.execPath`.
 */
const LAUNCHER = join(dirname(MODULE_PATH), `launch-target${extname(MODULE_PATH)}`);
/** The stdio target's launch spec, inside the run's scratch directory. */
const LAUNCH_SPEC_NAME = 'target-launch.json';

/**
 * Reject an unknown, inherited, or repeated adapter name, a pin naming no
 * adapter, and a blank pin, whose `<package>@` npm would quietly resolve to
 * latest. Each pin is checked whether or not its adapter is selected.
 */
function assertAdapterSelection(
  adapters: readonly string[],
  pins: Readonly<Record<string, unknown>>,
): void {
  const selected = new Set<string>();
  for (const name of adapters) {
    if (!isAdapterName(name)) {
      throw new CrosscheckUsageError(
        `unknown adapter "${name}" — known adapters: inspector, mcpo, codex, claude-code`,
      );
    }
    if (selected.has(name)) {
      throw new CrosscheckUsageError(`adapter "${name}" is selected more than once`);
    }
    selected.add(name);
  }
  for (const [name, version] of Object.entries(pins)) {
    if (!isAdapterName(name)) {
      throw new CrosscheckUsageError(`pins names unknown adapter "${name}"`);
    }
    if (typeof version !== 'string' || version.trim() === '') {
      throw new CrosscheckUsageError(
        `pin for adapter "${name}" must be a non-blank version string`,
      );
    }
  }
}

/**
 * Write a stdio target's launch spec into the run's scratch directory, which is
 * removed with the run, readable by this user only, and return the command line
 * every client starts in the target's place. The spec carries the environment,
 * so no `--env` value reaches a client's command line or configuration.
 */
async function launcherTarget(
  target: Extract<TargetSpec, { kind: 'stdio' }>,
  workDir: string,
): Promise<AdapterTarget> {
  const specPath = join(workDir, LAUNCH_SPEC_NAME);
  await writeFile(specPath, JSON.stringify(targetLaunch(target)), { flag: 'wx', mode: 0o600 });
  return { args: [LAUNCHER, specPath], command: process.execPath, kind: 'stdio' };
}

/**
 * Remove the run's scratch directory, the launch spec first: it holds `--env`
 * values, and unlinking it succeeds even while a client tree killed a moment
 * ago still has the directory as its cwd, which on Windows refuses the
 * directory's own removal (EBUSY) until that tree has exited. The retries
 * cover that window. Cleanup never fails the run; a directory it could not
 * remove is named in the log.
 */
async function removeWorkDir(workDir: string, log: (line: string) => void): Promise<void> {
  try {
    await rm(join(workDir, LAUNCH_SPEC_NAME), { force: true });
    await rm(workDir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  } catch (error) {
    log(
      `could not remove the scratch directory ${workDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Check an HTTP target's header map and URL scheme; a stdio target runs as given. */
function validatedTarget(target: TargetSpec): TargetSpec {
  if (target.kind === 'stdio') return target;
  let headers: Record<string, string>;
  try {
    headers = validateHttpHeaders(target.headers ?? {});
  } catch (error) {
    throw new CrosscheckUsageError(error instanceof Error ? error.message : String(error));
  }
  const { url } = target;
  if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) {
    const redact = createRedactor(Object.values(headers));
    throw new CrosscheckUsageError(
      redact(`target URL must be an http: or https: URL, got: ${url}`),
    );
  }
  return { headers, kind: 'http', url };
}

/** Run the full crosscheck: ground truth, canary preflight, every selected adapter. */
export async function runCrosscheck(options: CrosscheckOptions): Promise<RunReport> {
  // Caller mistakes that need no I/O are rejected first, before any file or process is touched.
  assertAdapterSelection(options.adapters, options.pins ?? {});
  const timeoutMs = options.timeoutMs ?? 120_000;
  // Node's own timer bound; the negated form also rejects NaN.
  if (!(timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new CrosscheckUsageError(
      `timeoutMs must be from 1 to ${MAX_TIMEOUT_MS} milliseconds, got: ${timeoutMs}`,
    );
  }
  const target = validatedTarget(options.target);
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
  for (const name of options.adapters) {
    const verdict = ADAPTERS[name].supports(target);
    if (verdict !== true) {
      throw new CrosscheckUsageError(`adapter "${name}": ${verdict}`);
    }
  }
  const redact = targetRedactor(target);
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

  // Everything after the scratch directory exists runs inside the boundary that removes it.
  const workDir = await mkdtemp(join(tmpdir(), 'mcp-crosscheck-'));
  try {
    if (artifactsDir !== null) {
      await mkdir(artifactsDir, { recursive: true });
    }
    log('capturing ground truth via the official MCP SDK client');
    const groundTruth = await captureGroundTruth(target, timeoutMs);
    const { truncation } = groundTruth;
    log(
      `ground truth: ${groundTruth.serverName ?? 'unnamed server'} advertises ${groundTruth.tools.length} tool(s)${
        truncation === null ? '' : `; ${truncationNote(truncation)}`
      }`,
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
          truncation === null
            ? `canary tool "${canary.tool}" is not advertised by the server`
            : `canary tool "${canary.tool}" was not found in the ${truncation.pagesRead} page(s) of tools/list read before the walk stopped (${truncation.reason})`,
        );
      }
      groundTruthCanary = await runGroundTruthCanary(target, canary, timeoutMs);
      if (groundTruthCanary.ok !== true) {
        throw new CrosscheckUsageError(
          `canary ${canary.tool} failed through the official MCP SDK client, before any adapter ran${
            groundTruthCanary.detail === null ? '' : `: ${groundTruthCanary.detail}`
          }`,
        );
      }
      log(`canary ${canary.tool} verified against ground truth`);
    }

    const adapterTarget = target.kind === 'http' ? target : await launcherTarget(target, workDir);
    const groundTruthNames = groundTruth.tools.map((tool) => tool.name);
    const adapterReports: AdapterReport[] = [];
    for (const name of options.adapters) {
      log(`running adapter: ${name}`);
      const adapter = ADAPTERS[name];
      const renames = adapter.toolRenames?.(groundTruthNames);
      // Paired here, not only inside buildFindings, so the status, detail, and tool count agree with the findings.
      const result = pairEmptyCapture(
        groundTruth.tools,
        await adapter.run({
          artifactsDir,
          canary,
          ...(options.exec === undefined ? {} : { exec: options.exec }),
          log,
          mcpoWith: options.mcpoWith ?? [],
          pins: options.pins ?? {},
          redact,
          target: adapterTarget,
          timeoutMs,
          workDir,
        }),
        renames,
      );
      const findings = buildFindings(groundTruth.tools, result, renames);
      adapterReports.push({
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
      });
    }

    const states = adapterReports.map((adapter) => ({
      adapter: adapter.adapter,
      comparisonSucceeded: adapter.status === 'ok' && adapter.toolCount !== null,
      findings: adapter.findings,
    }));
    // A truncated capture compared only the pages read: it can neither rewrite
    // reviewed entries nor call one stale.
    const eligibleForUpdate =
      truncation === null &&
      states.every(
        (state) =>
          state.comparisonSucceeded &&
          !state.findings.some((finding) => RUNTIME_RULES.has(finding.rule)),
      );
    if (updateRequested && baselinePath !== null && eligibleForUpdate) {
      baseline = updateBaseline(baseline, states);
      await writeBaselineAtomic(baselinePath, baseline);
    }
    const reconciliation = reconcileBaseline(baseline, states);
    const baselineDiagnostics = truncation === null ? reconciliation.baselineDiagnostics : [];
    for (const adapter of adapterReports) {
      const reconciled = reconciliation.adapters.find((entry) => entry.adapter === adapter.adapter);
      adapter.newFindings = reconciled?.newFindings ?? adapter.findings;
      adapter.acknowledgedFindings = reconciled?.acknowledgedFindings ?? [];
    }

    const allFindings = adapterReports.flatMap((adapter) => adapter.newFindings);
    const failCount = allFindings.filter((finding) => finding.severity === 'fail').length;
    // Ground-truth notes are info tier by type: they count as info and never change `pass`.
    const notes = groundTruthFindings(groundTruth.tools);
    const infoCount =
      allFindings.filter((finding) => finding.severity === 'info').length + notes.length;

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
      baselineDiagnostics,
      crosscheckVersion: VERSION,
      failCount,
      groundTruth: {
        canary: groundTruthCanary,
        depthLimitedPaths: depthLimitedPaths(groundTruth.tools),
        findings: notes,
        serverName: groundTruth.serverName,
        serverVersion: groundTruth.serverVersion,
        toolCount: groundTruth.tools.length,
        toolNames: groundTruth.tools.map((tool) => tool.name),
        truncation,
      },
      infoCount,
      // Tools past a truncated walk were never compared, so no finding count can pass the run.
      pass: failCount === 0 && truncation === null,
      reportVersion: 1,
      staleCount: baselineDiagnostics.length,
      target: reportTarget,
    };
    // One pass over the report's free text; identities reached the baseline unredacted above.
    const safeReport = redactRunReport(report, redact);
    registerReportRedactor(safeReport, redact);
    return safeReport;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    if (error instanceof CrosscheckUsageError) throw new CrosscheckUsageError(message);
    throw new Error(message);
  } finally {
    await removeWorkDir(workDir, log);
  }
}
