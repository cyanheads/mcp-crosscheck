/**
 * @file src/invariants.ts
 * The invariant engine: pure comparison of the ground-truth surface against a
 * client's rendered surface. Emits `fail` findings for divergence that breaks
 * agents in the wild and `info` findings for recorded degradation.
 *
 * Comparison follows the normalized model all the way down: nested object
 * fields and array elements are checked by the same rules as root properties,
 * each finding scoped by a dotted path (`tool.config.transport.timeoutMs`,
 * `tool.tags[].name`). Termination is guaranteed by the normalizer, which
 * bounds the depth it walks; `depthLimitedPaths` names where that bound cut off
 * advertised fields. An advertised `outputSchema` is walked the same way under
 * an `output:` path prefix, at info tier throughout.
 *
 * `groundTruthFindings` checks the advertised surface on its own, with no
 * client involved; its notes are reported once per run, never per adapter.
 */
import {
  isRecord,
  renderedPropertiesFromJsonSchema,
  renderedToolFromJsonSchema,
} from './schema.js';
import type {
  AdapterRunResult,
  Finding,
  GroundTruthFinding,
  GroundTruthTool,
  JsonSchema,
  RenderedProperty,
  RenderedSurface,
  RenderedTool,
} from './types.js';
import { canonicalJson } from './util/canonical-json.js';

function propertyNoun(count: number): string {
  return count === 1 ? 'property' : 'properties';
}

/** Description text for comparison: trimmed, each whitespace run collapsed to one space. */
function normalizeText(text: string | null): string {
  return text === null ? '' : text.trim().replace(/\s+/g, ' ');
}

/**
 * A trailing truncation marker on normalized text: `…`, `...`, `[truncated]`,
 * or `… [truncated]`, each with optional whitespace before it. Claude Code
 * 2.1.283 cuts a long tool description to 2,048 characters and appends
 * `… [truncated]`. Any other suffix is not a marker.
 */
const TRUNCATION_MARKER = /\s*(?:… \[truncated\]|\[truncated\]|…|\.\.\.)$/u;

/**
 * Compare an advertised description with its rendering, whitespace-normalized.
 * A rendering with no text left (`null`, empty, or whitespace) lost the
 * description. One that still contains the advertised text kept it, whatever
 * the client added around it. Anything else was altered: `truncated` when it is
 * a prefix of the advertised text, before or after removing one trailing
 * truncation marker, and `rewritten` otherwise. Lengths stay in `detail` — they
 * move with every server edit, so they are not identity.
 */
function compareDescription(
  advertised: string | null,
  rendered: string | null,
  path: string,
  subject: 'property' | 'tool',
): Finding[] {
  const expected = normalizeText(advertised);
  const actual = normalizeText(rendered);
  if (expected === '' || actual.includes(expected)) return [];
  if (actual === '') {
    return [
      {
        detail: `${subject} description was lost in rendering`,
        evidence: { kind: 'description-lost', subject },
        path,
        rule: 'description-lost',
        severity: 'fail',
      },
    ];
  }
  const kept = [actual, actual.replace(TRUNCATION_MARKER, '')].find((text) =>
    expected.startsWith(text),
  );
  return [
    {
      detail:
        kept === undefined
          ? `${subject} description was rewritten in rendering (${expected.length} characters advertised, ${actual.length} rendered)`
          : `${subject} description was truncated in rendering (${kept.length} of ${expected.length} characters kept)`,
      evidence: {
        change: kept === undefined ? 'rewritten' : 'truncated',
        kind: 'description-altered',
        subject,
      },
      path,
      rule: 'description-altered',
      severity: 'info',
    },
  ];
}

/** JSON kind of a constraint value, with arrays and null told apart from objects. */
function jsonKind(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/** Keywords that annotate a schema without constraining the values it accepts. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$comment',
  'default',
  'deprecated',
  'description',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);

/** Whether an `additionalProperties` value accepts every value: `true`, or a schema of annotations only. */
function acceptsAnyValue(value: unknown): boolean {
  if (value === true) return true;
  return isRecord(value) && Object.keys(value).every((keyword) => ANNOTATION_KEYWORDS.has(keyword));
}

/** Whether an `additionalProperties` value restricts extra properties: `false`, or a value schema. */
function restrictsExtraProperties(value: unknown): boolean {
  return (value === false || isRecord(value)) && !acceptsAnyValue(value);
}

/**
 * Whether a constraint keyword present on both sides holds a different value.
 * An `additionalProperties` that restricts extra properties (`false`, or a
 * value schema) rendered as one that accepts any value is a loosening, whatever
 * the JSON kind of either side. Otherwise only same-kind values compare: a kind
 * mismatch (a draft-4 boolean `exclusiveMinimum` against a numeric one) is a
 * re-encoding, not a change. A schema-valued `additionalProperties` rendered as
 * another schema is skipped — `$ref` indirection and injected titles change its
 * shape without changing the constraint. `enum` compares as a set, so
 * reordering or repeating a member is not drift; every other value compares as
 * canonical JSON, ignoring object key order.
 */
function constraintValueChanged(keyword: string, advertised: unknown, rendered: unknown): boolean {
  if (
    keyword === 'additionalProperties' &&
    restrictsExtraProperties(advertised) &&
    acceptsAnyValue(rendered)
  ) {
    return true;
  }
  const kind = jsonKind(advertised);
  if (kind !== jsonKind(rendered)) return false;
  if (keyword === 'additionalProperties' && kind === 'object') return false;
  if (keyword === 'enum' && kind === 'array') {
    const expected = new Set((advertised as unknown[]).map(canonicalJson));
    const actual = new Set((rendered as unknown[]).map(canonicalJson));
    return expected.symmetricDifference(actual).size > 0;
  }
  return canonicalJson(advertised) !== canonicalJson(rendered);
}

/** Raw required names, with the pre-metadata child flags as a compatibility fallback. */
function requiredNamesOf(property: RenderedProperty): string[] {
  return (
    property.requiredNames ??
    property.children?.filter((child) => child.required).map((child) => child.name) ??
    []
  );
}

/** Match rendered properties to ground-truth ones by name at one schema level. */
function compareProperties(
  gtProperties: RenderedProperty[],
  renderedProperties: RenderedProperty[],
  path: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const gtProperty of gtProperties) {
    const propertyPath = `${path}.${gtProperty.name}`;
    const renderedProperty = renderedProperties.find(
      (candidate) => candidate.name === gtProperty.name,
    );
    if (renderedProperty === undefined) {
      findings.push({
        detail:
          gtProperty.declaredIn === 'branch'
            ? 'input property is missing from the rendered surface — it is declared inside an anyOf/oneOf branch, which a converter reading only `properties` never sees'
            : 'input property is missing from the rendered surface',
        evidence: { declaredIn: gtProperty.declaredIn, kind: 'property-missing' },
        path: propertyPath,
        rule: 'property-missing',
        severity: 'fail',
      });
      continue;
    }
    // Ground truth that already excludes the property lost nothing in rendering.
    if (renderedProperty.excluded === true && gtProperty.excluded !== true) {
      findings.push({
        detail:
          'input property is excluded by the rendered schema — an `additionalProperties: false` at this level does not list it, so a model following the rendered schema can never send it',
        evidence: { kind: 'property-excluded' },
        path: propertyPath,
        rule: 'property-excluded',
        severity: 'fail',
      });
    }
    findings.push(...compareProperty(gtProperty, renderedProperty, propertyPath));
  }
  return findings;
}

/**
 * The object level below one property: its own fields and its own `required`
 * markers. A level rendered with none of its fields collapses to one scoped
 * finding rather than one per lost field.
 */
function compareNestedLevel(
  gt: RenderedProperty,
  rendered: RenderedProperty,
  path: string,
): Finding[] {
  const gtChildren = gt.children ?? [];
  const renderedChildren = rendered.children ?? [];
  if (gtChildren.length > 0 && renderedChildren.length === 0) {
    return [
      {
        detail: `ground truth declares ${gtChildren.length} nested ${propertyNoun(
          gtChildren.length,
        )} here but the client rendered the object with none — every nested field would be dropped`,
        evidence: {
          branchOnly: gtChildren.every((property) => property.declaredIn === 'branch'),
          expectedPropertyCount: gtChildren.length,
          kind: 'input-empty',
          scope: 'nested',
        },
        path,
        rule: 'empty-request-body',
        severity: 'fail',
      },
    ];
  }

  const findings = compareProperties(gtChildren, renderedChildren, path);
  const renderedRequiredNames = requiredNamesOf(rendered);
  const droppedRequired = requiredNamesOf(gt).filter(
    (name) => !renderedRequiredNames.includes(name),
  );
  if (droppedRequired.length > 0) {
    findings.push({
      detail: `required marker dropped for: ${droppedRequired.join(', ')}`,
      evidence: { kind: 'required-dropped', names: [...droppedRequired].sort() },
      path,
      rule: 'required-dropped',
      severity: 'fail',
    });
  }
  return findings;
}

/** Compare one property pair, then descend into its object fields and array elements. */
function compareProperty(
  gt: RenderedProperty,
  rendered: RenderedProperty,
  path: string,
): Finding[] {
  const findings: Finding[] = [];

  // An untyped rendering of an untyped advertisement is faithful, not a loss.
  if (rendered.type === null && gt.type !== null) {
    findings.push({
      detail: `property rendered with no type information (ground truth: ${gt.type})`,
      evidence: { groundTruthType: gt.type, kind: 'property-untyped' },
      path,
      rule: 'property-untyped',
      severity: 'fail',
    });
  }
  if (
    typeof gt.explicitType === 'string' &&
    typeof rendered.explicitType === 'string' &&
    gt.explicitType !== rendered.explicitType
  ) {
    findings.push({
      detail: `property explicit type changed from ${gt.explicitType} to ${rendered.explicitType}`,
      evidence: { from: gt.explicitType, kind: 'property-retyped', to: rendered.explicitType },
      path,
      rule: 'property-retyped',
      severity: 'fail',
    });
  }
  findings.push(...compareDescription(gt.description, rendered.description, path, 'property'));
  const advertisedKeywords = Object.keys(gt.constraints).sort();
  const droppedConstraints = advertisedKeywords.filter(
    (keyword) => rendered.constraints[keyword] === undefined,
  );
  if (droppedConstraints.length > 0) {
    findings.push({
      detail: `constraint keyword${droppedConstraints.length === 1 ? '' : 's'} dropped: ${droppedConstraints.join(', ')}`,
      evidence: { keywords: droppedConstraints, kind: 'constraint-dropped' },
      path,
      rule: 'constraint-dropped',
      severity: 'info',
    });
  }
  const alteredConstraints = advertisedKeywords.filter(
    (keyword) =>
      rendered.constraints[keyword] !== undefined &&
      constraintValueChanged(keyword, gt.constraints[keyword], rendered.constraints[keyword]),
  );
  if (alteredConstraints.length > 0) {
    const changes = alteredConstraints.map(
      (keyword) =>
        `${keyword} ${JSON.stringify(gt.constraints[keyword])} → ${JSON.stringify(rendered.constraints[keyword])}`,
    );
    findings.push({
      detail: `constraint value${alteredConstraints.length === 1 ? '' : 's'} changed: ${changes.join(', ')}`,
      evidence: { keywords: alteredConstraints, kind: 'constraint-altered' },
      path,
      rule: 'constraint-altered',
      severity: 'info',
    });
  }

  findings.push(...compareNestedLevel(gt, rendered, path));
  // Element schemas are compared only where both sides declare `items`.
  if (gt.items !== undefined && rendered.items !== undefined) {
    findings.push(...compareProperty(gt.items, rendered.items, `${path}[]`));
  }
  return findings;
}

function compareTool(gt: RenderedTool, rendered: RenderedTool): Finding[] {
  const findings: Finding[] = [];

  if (gt.properties.length > 0 && rendered.properties.length === 0) {
    const branchOnly = gt.properties.every((property) => property.declaredIn === 'branch');
    findings.push({
      detail: `ground truth advertises ${gt.properties.length} input ${propertyNoun(
        gt.properties.length,
      )}${
        branchOnly ? ', declared inside anyOf/oneOf branches,' : ''
      } but the client rendered an empty request body — every argument would be dropped`,
      evidence: {
        branchOnly,
        expectedPropertyCount: gt.properties.length,
        kind: 'input-empty',
        scope: 'root',
      },
      path: gt.name,
      rule: 'empty-request-body',
      severity: 'fail',
    });
    return findings;
  }

  findings.push(...compareDescription(gt.description, rendered.description, gt.name, 'tool'));
  findings.push(...compareProperties(gt.properties, rendered.properties, gt.name));

  const droppedRequired = gt.requiredNames.filter((name) => !rendered.requiredNames.includes(name));
  if (droppedRequired.length > 0) {
    findings.push({
      detail: `required marker dropped for: ${droppedRequired.join(', ')}`,
      evidence: { kind: 'required-dropped', names: [...droppedRequired].sort() },
      path: gt.name,
      rule: 'required-dropped',
      severity: 'fail',
    });
  }

  if (gt.hasRootUnion && !rendered.hasRootUnion) {
    findings.push({
      detail:
        'root anyOf/oneOf union is not represented in the rendered surface — the client cannot enforce which branch applies (fields declared inside the branches are compared as properties)',
      evidence: { kind: 'anyof-ignored' },
      path: gt.name,
      rule: 'anyof-ignored',
      severity: 'info',
    });
  }

  return findings;
}

/** Compare one result-model field pair, then descend into its fields and elements. */
function compareOutputProperty(
  gt: RenderedProperty,
  rendered: RenderedProperty,
  path: string,
): Finding[] {
  const findings: Finding[] = [];
  if (rendered.type === null && gt.type !== null) {
    findings.push({
      detail: `output field rendered with no type information (ground truth: ${gt.type})`,
      evidence: { groundTruthType: gt.type, kind: 'output-field-untyped' },
      path,
      rule: 'output-schema-divergence',
      severity: 'info',
    });
  }
  if (
    typeof gt.explicitType === 'string' &&
    typeof rendered.explicitType === 'string' &&
    gt.explicitType !== rendered.explicitType
  ) {
    findings.push({
      detail: `output field explicit type changed from ${gt.explicitType} to ${rendered.explicitType}`,
      evidence: {
        from: gt.explicitType,
        kind: 'output-field-retyped',
        to: rendered.explicitType,
      },
      path,
      rule: 'output-schema-divergence',
      severity: 'info',
    });
  }

  const gtChildren = gt.children ?? [];
  const renderedChildren = rendered.children ?? [];
  if (gtChildren.length > 0 && renderedChildren.length === 0) {
    findings.push({
      detail: `ground truth declares ${gtChildren.length} nested output field${
        gtChildren.length === 1 ? '' : 's'
      } here but the client rendered the object with none — every nested output field is absent`,
      evidence: { expectedPropertyCount: gtChildren.length, kind: 'output-nested-empty' },
      path,
      rule: 'output-schema-divergence',
      severity: 'info',
    });
  } else {
    findings.push(...compareOutputProperties(gtChildren, renderedChildren, path));
  }
  if (gt.items !== undefined && rendered.items !== undefined) {
    findings.push(...compareOutputProperty(gt.items, rendered.items, `${path}[]`));
  }
  return findings;
}

/** Match rendered result-model fields to ground-truth ones by name at one level. */
function compareOutputProperties(
  gtProperties: RenderedProperty[],
  renderedProperties: RenderedProperty[],
  path: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const gtProperty of gtProperties) {
    const propertyPath = `${path}.${gtProperty.name}`;
    const rendered = renderedProperties.find((candidate) => candidate.name === gtProperty.name);
    if (rendered === undefined) {
      findings.push({
        detail: 'output field is missing from the rendered result model',
        evidence: { kind: 'output-field-missing' },
        path: propertyPath,
        rule: 'output-schema-divergence',
        severity: 'info',
      });
      continue;
    }
    findings.push(...compareOutputProperty(gtProperty, rendered, propertyPath));
  }
  return findings;
}

/**
 * Diff an advertised `outputSchema` against the client's rendered result model.
 * Info tier throughout: a dropped output field misleads a model about what a
 * call returns, but no argument is lost, so it never fails a run. Both sides
 * must carry an output surface — a client that renders none (codex sends input
 * `parameters` only) has nothing to have lost.
 */
function compareOutput(gt: GroundTruthTool, rendered: RenderedTool): Finding[] {
  if (gt.outputSchema === undefined || rendered.outputProperties === undefined) return [];
  const gtProperties = renderedPropertiesFromJsonSchema(gt.outputSchema);
  const path = `output:${gt.name}`;
  if (gtProperties.length === 0) return [];
  if (rendered.outputProperties.length === 0) {
    return [
      {
        detail: `ground truth advertises ${gtProperties.length} output ${propertyNoun(
          gtProperties.length,
        )} but the client rendered the result model with none`,
        evidence: { expectedPropertyCount: gtProperties.length, kind: 'output-root-empty' },
        path,
        rule: 'output-schema-divergence',
        severity: 'info',
      },
    ];
  }
  return compareOutputProperties(gtProperties, rendered.outputProperties, path);
}

/** Diff ground truth against one rendered surface. Pure; no I/O. */
export function compareSurface(
  groundTruthTools: GroundTruthTool[],
  rendered: RenderedSurface,
): Finding[] {
  const findings: Finding[] = [];
  for (const tool of groundTruthTools) {
    const gtNormalized = renderedToolFromJsonSchema(tool.name, tool.description, tool.inputSchema);
    const renderedTool = rendered.tools.find((candidate) => candidate.name === tool.name);
    if (renderedTool === undefined) {
      findings.push({
        detail: 'tool is missing from the rendered surface',
        evidence: { kind: 'tool-missing' },
        path: tool.name,
        rule: 'tool-missing',
        severity: 'fail',
      });
      continue;
    }
    findings.push(...compareTool(gtNormalized, renderedTool));
    findings.push(...compareOutput(tool, renderedTool));
  }
  return findings;
}

/**
 * The root `$schema` dialects the MCP TypeScript SDK v2 client recognizes,
 * each in http or https and with or without one trailing `#`. Case-sensitive.
 * SDK v1, which captures ground truth, accepts any label.
 */
const RECOGNIZED_DIALECTS: ReadonlySet<string> = new Set(
  ['draft/2020-12/schema', 'draft/2019-09/schema', 'draft-07/schema', 'draft-06/schema'].flatMap(
    (dialect) =>
      ['http', 'https'].flatMap((scheme) => {
        const uri = `${scheme}://json-schema.org/${dialect}`;
        return [uri, `${uri}#`];
      }),
  ),
);

/** An `unsupported-dialect` note for a root `$schema` outside the recognized set, or null. */
function dialectFinding(
  schema: JsonSchema,
  path: string,
  subject: 'input' | 'output',
): GroundTruthFinding | null {
  const declared = schema.$schema;
  if (typeof declared !== 'string' || RECOGNIZED_DIALECTS.has(declared)) return null;
  return {
    detail: `${subject} schema declares the JSON Schema dialect ${declared}, which the MCP TypeScript SDK v2 client does not recognize (it recognizes 2020-12, 2019-09, draft-07, and draft-06)${
      subject === 'output' ? ' — TypeScript SDK v2 clients reject every call to this tool' : ''
    }`,
    evidence: { declared, kind: 'unsupported-dialect' },
    path,
    rule: 'unsupported-dialect',
    severity: 'info',
  };
}

/** An `sdk-v1-rejected` note for a tool the SDK 1.x `Tool` schema rejects, or null. */
function sdkV1Finding(tool: GroundTruthTool): GroundTruthFinding | null {
  if (tool.sdkV1Rejection === undefined || tool.sdkV1Rejection.length === 0) return null;
  return {
    detail: `clients on @modelcontextprotocol/sdk 1.x reject this tool's definition, and with it the whole tools/list result — ${tool.sdkV1Rejection.join('; ')}`,
    evidence: { kind: 'sdk-v1-rejected' },
    path: tool.name,
    rule: 'sdk-v1-rejected',
    severity: 'info',
  };
}

/**
 * Notes about the advertised surface itself, independent of any client, in
 * tool order: a tool definition the SDK 1.x `Tool` schema rejects (path
 * `<tool>`), then a root `$schema` naming a dialect the TypeScript SDK v2
 * client does not recognize, on `inputSchema` (path `<tool>`) or
 * `outputSchema` (path `output:<tool>`). An absent or non-string `$schema`,
 * and one below the root, say nothing. Pure; no I/O.
 */
export function groundTruthFindings(tools: GroundTruthTool[]): GroundTruthFinding[] {
  return tools.flatMap((tool) =>
    [
      sdkV1Finding(tool),
      dialectFinding(tool.inputSchema, tool.name, 'input'),
      tool.outputSchema === undefined
        ? null
        : dialectFinding(tool.outputSchema, `output:${tool.name}`, 'output'),
    ].filter((finding): finding is GroundTruthFinding => finding !== null),
  );
}

/** Add the path of every depth-limited property at or below this one. */
function collectDepthLimited(property: RenderedProperty, path: string, into: Set<string>): void {
  if (property.depthLimited === true) into.add(path);
  for (const child of property.children ?? []) {
    collectDepthLimited(child, `${path}.${child.name}`, into);
  }
  if (property.items !== undefined) collectDepthLimited(property.items, `${path}[]`, into);
}

/**
 * Where normalized ground truth stops at the normalizer's depth limit with
 * fields left below it, in finding path syntax: `[]` for array elements and an
 * `output:` prefix for an advertised `outputSchema`. Sorted by code unit, each
 * path once. Pure; no I/O.
 */
export function depthLimitedPaths(tools: GroundTruthTool[]): string[] {
  const paths = new Set<string>();
  for (const tool of tools) {
    const input = renderedToolFromJsonSchema(tool.name, tool.description, tool.inputSchema);
    for (const property of input.properties) {
      collectDepthLimited(property, `${tool.name}.${property.name}`, paths);
    }
    if (tool.outputSchema === undefined) continue;
    for (const property of renderedPropertiesFromJsonSchema(tool.outputSchema)) {
      collectDepthLimited(property, `output:${tool.name}.${property.name}`, paths);
    }
  }
  return [...paths].sort();
}

/** Assemble the full finding list for one adapter run, including run-level failures. */
export function buildFindings(
  groundTruthTools: GroundTruthTool[],
  result: AdapterRunResult,
): Finding[] {
  if (result.status === 'adapter-broken') {
    return [
      {
        detail: `adapter failed to launch (resolved version: ${result.resolvedVersion ?? 'unknown'})${
          result.statusDetail === null ? '' : ` — ${result.statusDetail}`
        }`,
        evidence: { kind: 'adapter-broken' },
        path: null,
        rule: 'adapter-broken',
        severity: 'fail',
      },
    ];
  }
  if (result.status === 'handshake-failure' || result.surface === null) {
    return [
      {
        detail: `client could not complete the MCP handshake${
          result.statusDetail === null ? '' : ` — ${result.statusDetail}`
        }`,
        evidence: { kind: 'handshake-failure' },
        path: null,
        rule: 'handshake-failure',
        severity: 'fail',
      },
    ];
  }

  const findings = compareSurface(groundTruthTools, result.surface);
  if (result.canary?.attempted === true && result.canary.ok === false) {
    findings.push({
      detail: `canary round-trip failed${result.canary.detail === null ? '' : ` — ${result.canary.detail}`}`,
      evidence: { kind: 'canary-failed' },
      path: null,
      rule: 'canary-failed',
      severity: 'fail',
    });
  }
  return findings;
}
