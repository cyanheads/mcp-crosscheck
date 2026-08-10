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
 * bounds the depth it walks. An advertised `outputSchema` is walked the same
 * way under an `output:` path prefix, at info tier throughout.
 */
import { renderedPropertiesFromJsonSchema, renderedToolFromJsonSchema } from './schema.js';
import type {
  AdapterRunResult,
  Finding,
  GroundTruthTool,
  RenderedProperty,
  RenderedSurface,
  RenderedTool,
} from './types.js';

function propertyNoun(count: number): string {
  return count === 1 ? 'property' : 'properties';
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
        path: propertyPath,
        rule: 'property-missing',
        severity: 'fail',
      });
      continue;
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
  if (gtChildren.length === 0) return [];
  const renderedChildren = rendered.children ?? [];
  if (renderedChildren.length === 0) {
    return [
      {
        detail: `ground truth declares ${gtChildren.length} nested ${propertyNoun(
          gtChildren.length,
        )} here but the client rendered the object with none — every nested field would be dropped`,
        path,
        rule: 'empty-request-body',
        severity: 'fail',
      },
    ];
  }

  const findings = compareProperties(gtChildren, renderedChildren, path);
  const droppedRequired = gtChildren
    .filter(
      (child) =>
        child.required &&
        renderedChildren.find((candidate) => candidate.name === child.name)?.required !== true,
    )
    .map((child) => child.name);
  if (droppedRequired.length > 0) {
    findings.push({
      detail: `required marker dropped for: ${droppedRequired.join(', ')}`,
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

  if (rendered.type === null) {
    findings.push({
      detail: `property rendered with no type information (ground truth: ${gt.type ?? 'untyped'})`,
      path,
      rule: 'property-untyped',
      severity: 'fail',
    });
  }
  if (gt.description !== null && gt.description !== '' && rendered.description === null) {
    findings.push({
      detail: 'property description was lost in rendering',
      path,
      rule: 'description-lost',
      severity: 'fail',
    });
  }
  const droppedConstraints = Object.keys(gt.constraints).filter(
    (keyword) => rendered.constraints[keyword] === undefined,
  );
  if (droppedConstraints.length > 0) {
    findings.push({
      detail: `constraint keyword${droppedConstraints.length === 1 ? '' : 's'} dropped: ${droppedConstraints.join(', ')}`,
      path,
      rule: 'constraint-dropped',
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
      path: gt.name,
      rule: 'empty-request-body',
      severity: 'fail',
    });
    return findings;
  }

  if (gt.description !== null && gt.description !== '' && rendered.description === null) {
    findings.push({
      detail: 'tool description was lost in rendering',
      path: gt.name,
      rule: 'description-lost',
      severity: 'fail',
    });
  }

  findings.push(...compareProperties(gt.properties, rendered.properties, gt.name));

  const droppedRequired = gt.requiredNames.filter((name) => !rendered.requiredNames.includes(name));
  if (droppedRequired.length > 0) {
    findings.push({
      detail: `required marker dropped for: ${droppedRequired.join(', ')}`,
      path: gt.name,
      rule: 'required-dropped',
      severity: 'fail',
    });
  }

  if (gt.hasRootUnion && !rendered.hasRootUnion) {
    findings.push({
      detail:
        'root anyOf/oneOf union is not represented in the rendered surface — the client cannot enforce which branch applies (fields declared inside the branches are compared as properties)',
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
  if (rendered.type === null) {
    findings.push({
      detail: `output field rendered with no type information (ground truth: ${gt.type ?? 'untyped'})`,
      path,
      rule: 'output-schema-divergence',
      severity: 'info',
    });
  }
  findings.push(...compareOutputProperties(gt.children ?? [], rendered.children ?? [], path));
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
      path: null,
      rule: 'canary-failed',
      severity: 'fail',
    });
  }
  return findings;
}
