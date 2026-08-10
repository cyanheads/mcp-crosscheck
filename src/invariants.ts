/**
 * @file src/invariants.ts
 * The invariant engine: pure comparison of the ground-truth surface against a
 * client's rendered surface. Emits `fail` findings for divergence that breaks
 * agents in the wild and `info` findings for recorded degradation.
 */
import { renderedToolFromJsonSchema } from './schema.js';
import type {
  AdapterRunResult,
  Finding,
  GroundTruthTool,
  RenderedSurface,
  RenderedTool,
} from './types.js';

function compareTool(gt: RenderedTool, rendered: RenderedTool): Finding[] {
  const findings: Finding[] = [];

  if (gt.properties.length > 0 && rendered.properties.length === 0) {
    findings.push({
      detail: `ground truth advertises ${gt.properties.length} input propert${
        gt.properties.length === 1 ? 'y' : 'ies'
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

  for (const gtProperty of gt.properties) {
    const path = `${gt.name}.${gtProperty.name}`;
    const renderedProperty = rendered.properties.find((p) => p.name === gtProperty.name);
    if (renderedProperty === undefined) {
      findings.push({
        detail: 'input property is missing from the rendered surface',
        path,
        rule: 'property-missing',
        severity: 'fail',
      });
      continue;
    }
    if (renderedProperty.type === null) {
      findings.push({
        detail: `property rendered with no type information (ground truth: ${gtProperty.type ?? 'untyped'})`,
        path,
        rule: 'property-untyped',
        severity: 'fail',
      });
    }
    if (
      gtProperty.description !== null &&
      gtProperty.description !== '' &&
      renderedProperty.description === null
    ) {
      findings.push({
        detail: 'property description was lost in rendering',
        path,
        rule: 'description-lost',
        severity: 'fail',
      });
    }
    const droppedConstraints = Object.keys(gtProperty.constraints).filter(
      (keyword) => renderedProperty.constraints[keyword] === undefined,
    );
    if (droppedConstraints.length > 0) {
      findings.push({
        detail: `constraint keyword${droppedConstraints.length === 1 ? '' : 's'} dropped: ${droppedConstraints.join(', ')}`,
        path,
        rule: 'constraint-dropped',
        severity: 'info',
      });
    }
  }

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
        'root anyOf/oneOf union is not represented in the rendered surface (advisory unless branches carry fields absent from root properties)',
      path: gt.name,
      rule: 'anyof-ignored',
      severity: 'info',
    });
  }

  return findings;
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
