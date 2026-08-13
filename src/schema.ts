/**
 * @file src/schema.ts
 * JSON Schema normalization: turns any JSON-Schema-shaped tool surface (ground
 * truth, MCP Inspector output, Codex function parameters, an mcpo result model)
 * into the comparable `RenderedTool` / `RenderedProperty` model. Local `$ref`s
 * are resolved against the containing document; remote refs are left untouched.
 *
 * Normalization walks the whole schema — nested objects and array elements —
 * and flattens each level's `properties` together with the `properties` of its
 * `anyOf`/`oneOf` branches. Every caller gets the same treatment, ground truth
 * and client renderings alike: the diff only means anything if both sides
 * flatten identically.
 */
import type { JsonSchema, RenderedProperty, RenderedTool } from './types.js';

/**
 * Levels the walk descends before it stops. Together with the visited set this
 * is the only termination guarantee for a schema that recurses structurally
 * (`$defs.Node.properties.child.$ref` → `#/$defs/Node`): `resolveRef`'s own
 * counter bounds `$ref` → `$ref` chains within one resolution and resets on
 * every call, so such a schema never reaches it.
 */
const MAX_DEPTH = 6;

/** Validation-bearing keywords compared between ground truth and rendered surfaces. */
export const CONSTRAINT_KEYWORDS = [
  'additionalProperties',
  'const',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'multipleOf',
  'pattern',
  'uniqueItems',
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve a local `#/`-prefixed `$ref` against the root document, guarding against cycles. */
export function resolveRef(schema: unknown, root: unknown, depth = 0): JsonSchema | null {
  if (!isRecord(schema)) return null;
  const ref = schema.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return schema;
  // About to follow another ref: a chain this deep is cyclic — unresolvable.
  if (depth > 16) return null;
  let cursor: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return resolveRef(cursor, root, depth + 1);
}

/**
 * Effective type of a property schema: the explicit `type`, or a synthesized
 * marker when type information arrives another way (enum/const/union). Returns
 * null only when the schema carries no type information at all — the
 * `property-untyped` failure class.
 */
export function effectiveType(schema: JsonSchema, root: unknown): string | null {
  const { type } = schema;
  if (typeof type === 'string') return type;
  if (Array.isArray(type) && type.length > 0) return type.map(String).sort().join('|');
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return `enum<${typeof schema.enum[0]}>`;
  }
  if (schema.const !== undefined) return `const<${typeof schema.const}>`;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      const branchTypes = branches
        .map((branch) => {
          const resolved = resolveRef(branch, root);
          return resolved === null ? null : effectiveType(resolved, root);
        })
        .filter((branchType): branchType is string => branchType !== null);
      if (branchTypes.length > 0) return `${key}<${[...new Set(branchTypes)].sort().join('|')}>`;
    }
  }
  return null;
}

/** Canonicalize only an explicit JSON Schema `type` keyword for equality comparison. */
export function explicitType(schema: JsonSchema): string | null {
  const { type } = schema;
  if (typeof type === 'string') return type;
  if (
    Array.isArray(type) &&
    type.length > 0 &&
    type.every((member): member is string => typeof member === 'string')
  ) {
    return [...type].sort().join('|');
  }
  return null;
}

/** Extract the constraint keywords present on a property schema. */
export function extractConstraints(schema: JsonSchema): Record<string, unknown> {
  const constraints: Record<string, unknown> = {};
  for (const keyword of CONSTRAINT_KEYWORDS) {
    if (schema[keyword] !== undefined) constraints[keyword] = schema[keyword];
  }
  return constraints;
}

/**
 * Names listed in one schema's own `required` array. Branch `required` arrays
 * are excluded by construction: a branch's requirement holds only when that
 * branch applies, so it never becomes an unconditional requirement.
 */
function requiredNamesOf(schema: JsonSchema): string[] {
  return Array.isArray(schema.required) ? schema.required.map(String) : [];
}

/**
 * Layer a `$ref`'s sibling keywords over the schema it points at. Siblings are
 * valid since JSON Schema 2020-12 / OpenAPI 3.1, and converters put the
 * reference-site annotation there — mcpo renders a nested object as
 * `{$ref, description}` — so dropping them would report a description the
 * client actually kept as lost.
 */
function withRefSiblings(target: JsonSchema, source: unknown): JsonSchema {
  if (!isRecord(source) || typeof source.$ref !== 'string') return target;
  const siblings = Object.entries(source).filter(([keyword]) => keyword !== '$ref');
  return siblings.length === 0 ? target : { ...target, ...Object.fromEntries(siblings) };
}

/** Normalize one property schema, descending into its object fields and array elements. */
function propertyFrom(
  name: string,
  rawSchema: unknown,
  declaredIn: RenderedProperty['declaredIn'],
  required: boolean,
  doc: unknown,
  depth: number,
  seen: ReadonlySet<object>,
): RenderedProperty {
  const resolved = resolveRef(rawSchema, doc);
  if (resolved === null) {
    return {
      constraints: {},
      declaredIn,
      description: null,
      explicitType: null,
      name,
      required,
      requiredNames: [],
      type: null,
    };
  }
  const schema = withRefSiblings(resolved, rawSchema);
  const property: RenderedProperty = {
    constraints: extractConstraints(schema),
    declaredIn,
    description: typeof schema.description === 'string' ? schema.description : null,
    explicitType: explicitType(schema),
    name,
    required,
    requiredNames: requiredNamesOf(schema),
    type: effectiveType(schema, doc),
  };
  // The visited set tracks the ref target, so a loop back to it is caught
  // whatever the reference site layered on top.
  if (depth >= MAX_DEPTH || seen.has(resolved)) return property;

  const nestedSeen = new Set(seen).add(resolved);
  const children = propertiesOf(schema, doc, depth + 1, nestedSeen);
  if (children.length > 0) property.children = children;
  if (isRecord(schema.items)) {
    property.items = propertyFrom('[]', schema.items, 'root', false, doc, depth + 1, nestedSeen);
  }
  return property;
}

/**
 * Every property declared at one schema level: the level's own `properties`
 * first, then the `properties` of each `anyOf`/`oneOf` branch. A name declared
 * at the level itself wins; a name repeated across branches is collected once.
 */
function propertiesOf(
  schema: JsonSchema,
  doc: unknown,
  depth: number,
  seen: ReadonlySet<object>,
): RenderedProperty[] {
  const requiredNames = requiredNamesOf(schema);
  const properties: RenderedProperty[] = [];
  const collected = new Set<string>();

  const collect = (
    entries: Record<string, unknown>,
    declaredIn: RenderedProperty['declaredIn'],
  ): void => {
    for (const [name, rawSchema] of Object.entries(entries)) {
      if (collected.has(name)) continue;
      collected.add(name);
      properties.push(
        propertyFrom(name, rawSchema, declaredIn, requiredNames.includes(name), doc, depth, seen),
      );
    }
  };

  if (isRecord(schema.properties)) collect(schema.properties, 'root');
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const resolved = resolveRef(branch, doc);
      if (resolved === null || !isRecord(resolved.properties)) continue;
      collect(resolved.properties, 'branch');
    }
  }
  return properties;
}

/**
 * Normalize a standalone schema's property tree — the shape a result model is
 * compared as, where only the fields matter and there is no tool-level
 * description or root `required` list to carry.
 */
export function renderedPropertiesFromJsonSchema(
  schema: unknown,
  root?: unknown,
): RenderedProperty[] {
  const doc = root ?? schema;
  const resolved = resolveRef(schema, doc) ?? {};
  return propertiesOf(resolved, doc, 0, new Set([resolved]));
}

/**
 * Normalize one JSON-Schema-shaped tool input into the comparable model.
 * `root` defaults to the schema itself; pass the enclosing document when the
 * schema lives inside one (e.g. an OpenAPI components tree).
 */
export function renderedToolFromJsonSchema(
  name: string,
  description: string | null,
  inputSchema: unknown,
  root?: unknown,
): RenderedTool {
  const doc = root ?? inputSchema;
  const schema = resolveRef(inputSchema, doc) ?? {};
  return {
    description,
    hasRootUnion: Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf),
    name,
    properties: propertiesOf(schema, doc, 0, new Set([schema])),
    requiredNames: requiredNamesOf(schema),
  };
}
