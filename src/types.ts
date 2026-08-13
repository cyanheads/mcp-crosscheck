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
  | { kind: 'http'; url: string };

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
}

/** The server's own advertised surface, captured via the official MCP SDK client. */
export interface GroundTruth {
  serverName: string | null;
  serverVersion: string | null;
  tools: GroundTruthTool[];
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
   * `root` when the property is declared in the containing schema's `properties`,
   * `branch` when it appears only inside one of that schema's `anyOf`/`oneOf` branches.
   */
  declaredIn: 'branch' | 'root';
  description: string | null;
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
  | 'constraint-dropped'
  | 'description-lost'
  | 'empty-request-body'
  | 'handshake-failure'
  | 'output-schema-divergence'
  | 'property-missing'
  | 'property-retyped'
  | 'property-untyped'
  | 'required-dropped'
  | 'tool-missing';

/** One divergence between ground truth and a rendered surface. */
export interface Finding {
  detail: string;
  /** `tool` or `tool.property` when the finding is scoped below the adapter. */
  path: string | null;
  rule: RuleId;
  severity: Severity;
}

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
  adapter: AdapterName;
  canary: CanaryOutcome | null;
  durationMs: number;
  findings: Finding[];
  resolvedVersion: string | null;
  status: AdapterRunResult['status'];
  statusDetail: string | null;
  /** Tools the adapter rendered, or null when no surface was captured. */
  toolCount: number | null;
}

/** The complete result of one crosscheck run. */
export interface RunReport {
  adapters: AdapterReport[];
  crosscheckVersion: string;
  failCount: number;
  groundTruth: {
    canary: CanaryOutcome | null;
    serverName: string | null;
    serverVersion: string | null;
    toolCount: number;
    toolNames: string[];
  };
  infoCount: number;
  pass: boolean;
  target: { kind: 'stdio'; command: string; args: string[] } | { kind: 'http'; url: string };
}
