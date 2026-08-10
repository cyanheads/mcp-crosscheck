/**
 * @file src/index.ts
 * Public programmatic API: run a crosscheck, or use the pieces (ground-truth
 * capture, invariant engine, adapters, report rendering) individually.
 */

export { surfaceFromCodexBody } from './adapters/codex.js';
export { ADAPTERS, DEFAULT_ADAPTERS, isAdapterName } from './adapters/index.js';
export { surfaceFromOpenApiDoc } from './adapters/mcpo.js';
export { captureGroundTruth, runGroundTruthCanary } from './ground-truth.js';
export { buildFindings, compareSurface } from './invariants.js';
export { renderHumanReport, toJsonReport } from './report.js';
export type { CrosscheckOptions } from './run.js';
export { CrosscheckUsageError, runCrosscheck } from './run.js';
export {
  CONSTRAINT_KEYWORDS,
  effectiveType,
  renderedPropertiesFromJsonSchema,
  renderedToolFromJsonSchema,
  resolveRef,
} from './schema.js';
export type * from './types.js';
export type { Exec, ExecResult } from './util/exec.js';
export { nodeExec } from './util/exec.js';
export { VERSION } from './version.js';
