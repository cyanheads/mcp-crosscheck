/**
 * @file src/types.ts
 * Core domain types: the target server under test, the ground-truth surface,
 * the normalized rendered surface each client produces, and the findings the
 * invariant engine emits when the two disagree.
 */
import type { Exec } from './util/exec.js';

/** A loose JSON Schema object, as advertised in `tools/list`. */
export type JsonSchema = Record<string, unknown>;

/** The MCP server under test: a spawnable stdio command or a running streamable-http endpoint. */
export type TargetSpec =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'http'; headers?: Record<string, string>; url: string };

/** A safe tool to round-trip through each adapter, with exact arguments. Never synthesized. */
export interface CanarySpec {
  args: Record<string, unknown>;
  tool: string;
}

/** One tool as the server itself advertises it. */
export interface GroundTruthTool {
  description: string | null;
  inputSchema: JsonSchema;
  name: string;
  /** Result schema, present only for the tools that advertise one. */
  outputSchema?: JsonSchema;
  /**
   * Where the `Tool` schema of `@modelcontextprotocol/sdk` 1.x rejects this
   * tool, one `<path>: <message>` entry per failing location. Present only
   * when it rejects: a client on that SDK then rejects the whole list.
   */
  sdkV1Rejection?: string[];
}

/** Why a `tools/list` walk ended before the server's last page. */
export interface GroundTruthTruncation {
  pagesRead: number;
  /**
   * `cursor-repeated`: a page's `nextCursor` equals a cursor already sent.
   * `page-cap`: the walk's page limit was reached with a `nextCursor` in hand.
   */
  reason: 'cursor-repeated' | 'page-cap';
}

/** The server's own advertised surface, captured via the official MCP SDK client. */
export interface GroundTruth {
  serverName: string | null;
  serverVersion: string | null;
  tools: GroundTruthTool[];
  /** Null only when the last page read carried no `nextCursor`: the list is complete. */
  truncation: GroundTruthTruncation | null;
}

/**
 * One input property, normalized from whatever model a client renders. Nested
 * object fields and array elements recurse through the same shape.
 */
export interface RenderedProperty {
  /** Properties of this property's own object schema; omitted when it declares none. */
  children?: RenderedProperty[];
  /** Validation-bearing keywords present on the property (minimum, pattern, enum, ...). */
  constraints: Record<string, unknown>;
  /**
   * `root` when the property applies unconditionally — declared in the containing
   * schema's own `properties` or in one of its `allOf` members — and `branch` when
   * it appears only inside one of that level's `anyOf`/`oneOf` branches.
   */
  declaredIn: 'branch' | 'root';
  /**
   * Set when the walk stopped here at the normalizer's depth limit while the
   * schema still declares fields (its own, an `allOf` member's, or an
   * `anyOf`/`oneOf` branch's) or an element schema: nothing below this
   * property was normalized, so nothing below it is compared. A loop back to a
   * schema already on the path is never marked — that schema was compared
   * where it first appeared.
   */
  depthLimited?: true;
  description: string | null;
  /**
   * True when a closed schema at the containing level (its own or an `allOf`
   * member's `additionalProperties: false`) neither lists nor pattern-matches
   * this property, so no value for it validates. Normalized surfaces populate
   * it; legacy producers may omit.
   */
  excluded?: boolean;
  /** Canonical explicit `type`; normalized surfaces populate it, while legacy producers may omit. */
  explicitType?: string | null;
  /** Element schema when this property is an array; omitted when it declares no `items`. */
  items?: RenderedProperty;
  name: string;
  required: boolean;
  /** Own schema-level `required` names; normalized surfaces populate it. */
  requiredNames?: string[];
  /** Effective type, or null when the property carries no type information at all. */
  type: string | null;
}

/** One tool as a client rendered it, normalized for comparison. */
export interface RenderedTool {
  description: string | null;
  /** Whether the rendered root schema still carries an `anyOf`/`oneOf` union. */
  hasRootUnion: boolean;
  name: string;
  /**
   * Fields of the client's rendered result model. Omitted when the client has
   * no output surface at all — absence of a surface, not loss of one.
   */
  outputProperties?: RenderedProperty[];
  properties: RenderedProperty[];
  requiredNames: string[];
}

/** A client's full rendered view of the server. */
export interface RenderedSurface {
  tools: RenderedTool[];
}

/** `fail` breaks agents in the wild; `info` is recorded degradation that never fails a run. */
export type Severity = 'fail' | 'info';

/** Stable identifiers for every invariant the engine checks. */
export type RuleId =
  | 'adapter-broken'
  | 'anyof-ignored'
  | 'canary-failed'
  | 'constraint-altered'
  | 'constraint-dropped'
  | 'description-altered'
  | 'description-lost'
  | 'empty-request-body'
  | 'handshake-failure'
  | 'output-schema-divergence'
  | 'property-excluded'
  | 'property-missing'
  | 'property-retyped'
  | 'property-untyped'
  | 'required-dropped'
  | 'sdk-v1-rejected'
  | 'tool-missing'
  | 'unsupported-dialect';

/**
 * Rules that describe the advertised surface itself rather than a client's
 * rendering of it. They are the same for every adapter, so they are reported
 * once, under `RunReport['groundTruth'].findings`, and are never baselined.
 */
export type GroundTruthRuleId = 'sdk-v1-rejected' | 'unsupported-dialect';

/** Stable machine facts carried by a finding; human `detail` is never an identity source. */
export type FindingEvidence =
  | { kind: 'adapter-broken' }
  | { kind: 'anyof-ignored' }
  | { kind: 'canary-failed' }
  | { keywords: string[]; kind: 'constraint-altered' }
  | { keywords: string[]; kind: 'constraint-dropped' }
  | { change: 'rewritten' | 'truncated'; kind: 'description-altered'; subject: 'property' | 'tool' }
  | { kind: 'description-lost'; subject: 'property' | 'tool' }
  | {
      branchOnly: boolean;
      expectedPropertyCount: number;
      kind: 'input-empty';
      scope: 'nested' | 'root';
    }
  | { kind: 'handshake-failure' }
  | { kind: 'property-excluded' }
  | { declaredIn: 'branch' | 'root'; kind: 'property-missing' }
  | { groundTruthType: string | null; kind: 'property-untyped' }
  | { from: string; kind: 'property-retyped'; to: string }
  | { kind: 'required-dropped'; names: string[] }
  | { kind: 'tool-missing' }
  | { kind: 'output-field-missing' }
  | { groundTruthType: string | null; kind: 'output-field-untyped' }
  | { from: string; kind: 'output-field-retyped'; to: string }
  | { expectedPropertyCount: number; kind: 'output-root-empty' }
  | { expectedPropertyCount: number; kind: 'output-nested-empty' }
  | { kind: 'sdk-v1-rejected' }
  | { declared: string; kind: 'unsupported-dialect' };

/** Rendering-only evidence accepted by a compatibility baseline. */
export type BaselineEvidence = Exclude<
  FindingEvidence,
  { kind: 'adapter-broken' | 'canary-failed' | 'handshake-failure' | GroundTruthRuleId }
>;

/** Rules that describe a rendered surface and may be acknowledged in a baseline. */
export type BaselineableRuleId = Exclude<
  RuleId,
  'adapter-broken' | 'canary-failed' | 'handshake-failure' | GroundTruthRuleId
>;

/** One divergence between ground truth and a rendered surface. */
export interface Finding {
  detail: string;
  evidence: FindingEvidence;
  /** `tool` or `tool.property` when the finding is scoped below the adapter. */
  path: string | null;
  rule: RuleId;
  severity: Severity;
}

/**
 * A note about the advertised surface itself, reported once for the run.
 * Always info tier: it is counted in `infoCount`, never changes `pass`, and
 * never enters a baseline.
 */
export type GroundTruthFinding = Finding & {
  evidence: Extract<FindingEvidence, { kind: GroundTruthRuleId }>;
  rule: GroundTruthRuleId;
  severity: 'info';
};

/** Outcome of the canary round-trip through one path (ground truth or an adapter). */
export interface CanaryOutcome {
  /** False when the path cannot express the canary (e.g. capture-only adapters). */
  attempted: boolean;
  detail: string | null;
  ok: boolean | null;
}

/** Adapter identifiers. Capture-only agent CLIs are opt-in. */
export type AdapterName = 'claude-code' | 'codex' | 'inspector' | 'mcpo';

/** Everything an adapter needs to run hermetically. */
export interface AdapterContext {
  /** Directory to persist raw captures into, or null to discard them. */
  artifactsDir: string | null;
  canary: CanarySpec | null;
  /** Process-execution seam; omitted means real child processes. */
  exec?: Exec;
  log: (line: string) => void;
  /** Extra `uvx --with` dependency constraints for the mcpo adapter (e.g. `mcp<2`). */
  mcpoWith: string[];
  /** Adapter name → exact version, overriding the latest-floats default. */
  pins: Partial<Record<AdapterName, string>>;
  /** Remove configured header values from crosscheck-owned diagnostics. */
  redact: (text: string) => string;
  target: TargetSpec;
  timeoutMs: number;
  /** Empty scratch directory used as a neutral cwd so package managers resolve no manifest. */
  workDir: string;
}

/** What happened when one adapter ran. */
export interface AdapterRunResult {
  adapter: AdapterName;
  canary: CanaryOutcome | null;
  durationMs: number;
  /** Resolved version of the client actually exercised — latest floats, so every run records it. */
  resolvedVersion: string | null;
  /**
   * `ok`: surface captured. `handshake-failure`: client ran but could not speak to the server.
   * `adapter-broken`: the client itself failed to launch (install/import failure).
   */
  status: 'adapter-broken' | 'handshake-failure' | 'ok';
  statusDetail: string | null;
  surface: RenderedSurface | null;
}

/** A runnable client adapter. */
export interface Adapter {
  name: AdapterName;
  /** True when the adapter only runs if explicitly selected. */
  optIn: boolean;
  run(ctx: AdapterContext): Promise<AdapterRunResult>;
  /** Returns true when the adapter can exercise this target, or a reason string when it cannot. */
  supports(target: TargetSpec): string | true;
}

/** Per-adapter slice of the final report. */
export interface AdapterReport {
  acknowledgedFindings: Finding[];
  adapter: AdapterName;
  canary: CanaryOutcome | null;
  durationMs: number;
  findings: Finding[];
  newFindings: Finding[];
  resolvedVersion: string | null;
  status: AdapterRunResult['status'];
  statusDetail: string | null;
  /** Tools the adapter rendered, or null when no surface was captured. */
  toolCount: number | null;
}

/** One reviewed rendering-finding identity in a version-1 baseline. */
export interface BaselineEntry {
  adapter: AdapterName;
  evidence: BaselineEvidence;
  path: string;
  rule: BaselineableRuleId;
}

/** Strict persisted baseline document. */
export interface BaselineDocument {
  baselineVersion: 1;
  entries: BaselineEntry[];
}

/** Informational report item for a reviewed finding no longer observed. */
export interface BaselineDiagnostic {
  adapter: AdapterName;
  entry: BaselineEntry;
  kind: 'stale';
}

/** The complete result of one crosscheck run. */
export interface RunReport {
  acknowledgedCount: number;
  adapters: AdapterReport[];
  baselineDiagnostics: BaselineDiagnostic[];
  crosscheckVersion: string;
  failCount: number;
  groundTruth: {
    canary: CanaryOutcome | null;
    /**
     * Where the comparison stopped at the normalizer's depth limit, in finding
     * path syntax (`[]` for array elements, `output:` for an `outputSchema`),
     * sorted. Nothing below these paths was compared. Not a finding: it is the
     * same for every adapter, never baselined, and never changes `pass`.
     */
    depthLimitedPaths: string[];
    /** Notes about the advertised surface itself, in tool order. */
    findings: GroundTruthFinding[];
    serverName: string | null;
    serverVersion: string | null;
    toolCount: number;
    toolNames: string[];
    /**
     * Why the `tools/list` walk stopped before the server's last page, or null
     * when it read the whole list. A truncated capture fails the run: tools
     * past the pages read were never compared.
     */
    truncation: GroundTruthTruncation | null;
  };
  infoCount: number;
  /** `failCount === 0 && groundTruth.truncation === null`. */
  pass: boolean;
  /** Shape version of this report contract; bumps only on an incompatible change. */
  reportVersion: 1;
  staleCount: number;
  target: { kind: 'stdio'; command: string; args: string[] } | { kind: 'http'; url: string };
}

/**
 * What `--json` prints when a run ends without a report. `usage` is a caller
 * mistake (exit 2); `runtime` is a failure while running (exit 1).
 */
export interface ErrorReport {
  error: { kind: 'runtime' | 'usage'; message: string };
  reportVersion: 1;
}
