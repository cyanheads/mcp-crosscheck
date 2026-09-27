/**
 * @file src/schema.ts
 * JSON Schema normalization: turns any JSON-Schema-shaped tool surface (ground
 * truth, MCP Inspector output, Codex function parameters, an mcpo result model)
 * into the comparable `RenderedTool` / `RenderedProperty` model. Local `$ref`s
 * (`#` and `#/…`) are resolved against the containing document; remote refs
 * are left untouched.
 *
 * Normalization walks the whole schema — nested objects and array elements —
 * and flattens each level: its own `properties`, those of every `allOf` member
 * (members apply unconditionally, so they belong to the level), and those of
 * its `anyOf`/`oneOf` branches. Every caller gets the same treatment, ground
 * truth and client renderings alike: the diff only means anything if both
 * sides flatten identically.
 */
import type { JsonSchema, RenderedProperty, RenderedTool } from './types.js';

/**
 * Levels the walk descends before it stops. Together with the visited set this
 * is the only termination guarantee for a schema that recurses structurally
 * (`$defs.Node.properties.child.$ref` → `#/$defs/Node`): `resolveRef`'s own
 * counter bounds `$ref` → `$ref` chains within one resolution and resets on
 * every call, so such a schema never reaches it. A property the cap cuts off
 * from fields it still declares is marked `depthLimited`.
 */
const MAX_DEPTH = 6;

/** Where a property sits in the level that declares it. */
type Placement = Required<Pick<RenderedProperty, 'declaredIn' | 'excluded' | 'required'>>;

/** An array's element schema: not a named member of any level. */
const ARRAY_ELEMENT: Placement = { declaredIn: 'root', excluded: false, required: false };

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

/**
 * Resolve a local `$ref` — the whole document (`#`) or a `#/` pointer into it —
 * against the root document, guarding against cycles. Each pointer segment
 * steps through own keys only, so `#/__proto__` dangles like `#/missing`.
 */
export function resolveRef(schema: unknown, root: unknown, depth = 0): JsonSchema | null {
  if (!isRecord(schema)) return null;
  const ref = schema.$ref;
  if (typeof ref !== 'string' || (ref !== '#' && !ref.startsWith('#/'))) return schema;
  // About to follow another ref: a chain this deep is cyclic — unresolvable.
  if (depth > 16) return null;
  let cursor: unknown = root;
  for (const segment of ref === '#' ? [] : ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(cursor) || !Object.hasOwn(cursor, key)) return null;
    cursor = cursor[key];
  }
  return resolveRef(cursor, root, depth + 1);
}

/**
 * Effective type of a property schema: the explicit `type`, or a synthesized
 * marker when type information arrives another way (enum/const/union). Returns
 * null only when the schema carries no type information at all — the
 * `property-untyped` failure class. A branch that loops back to a schema
 * already being typed contributes nothing, so a self-referencing union takes
 * its type from its other branches.
 */
export function effectiveType(
  schema: JsonSchema,
  root: unknown,
  seen: ReadonlySet<object> = new Set(),
): string | null {
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
      const path = new Set(seen).add(schema);
      const branchTypes = branches
        .map((branch) => {
          const resolved = resolveRef(branch, root);
          return resolved === null || path.has(resolved)
            ? null
            : effectiveType(resolved, root, path);
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
 * Names one level requires: the `required` arrays of its unconditional schemas
 * (the level's own, then each `allOf` member's), once each. Branch `required`
 * arrays are excluded by construction: a branch's requirement holds only when
 * that branch applies, so it never becomes an unconditional requirement.
 */
function requiredNamesOf(schemas: JsonSchema[]): string[] {
  const names = schemas.flatMap((schema) =>
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  return [...new Set(names)];
}

/**
 * Whether a closed schema (`additionalProperties: false`) rejects a property
 * name: the name is neither in its own `properties` nor matched by one of its
 * `patternProperties`. `additionalProperties` sees only the schema object it
 * sits in, so a name declared in an `allOf` member or an `anyOf`/`oneOf`
 * branch is rejected all the same. A pattern that is not a valid regular
 * expression counts as matching, so an unreadable pattern never manufactures
 * a rejection.
 */
function rejects(schema: JsonSchema, name: string): boolean {
  if (schema.additionalProperties !== false) return false;
  if (isRecord(schema.properties) && Object.hasOwn(schema.properties, name)) return false;
  const patterns = isRecord(schema.patternProperties) ? Object.keys(schema.patternProperties) : [];
  return !patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'u').test(name);
    } catch {
      return true;
    }
  });
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

/**
 * The schemas that apply unconditionally at one level: the level itself, then
 * each `allOf` member in document order, recursively. A member resolves
 * through `$ref` like a property schema does; a ref target reached twice — an
 * `allOf` cycle — is walked once.
 */
function unconditionalSchemas(level: JsonSchema, doc: unknown): JsonSchema[] {
  const schemas: JsonSchema[] = [];
  const visited = new Set<object>();
  const visit = (schema: JsonSchema, target: object): void => {
    if (visited.has(target)) return;
    visited.add(target);
    schemas.push(schema);
    if (!Array.isArray(schema.allOf)) return;
    for (const member of schema.allOf) {
      const resolved = resolveRef(member, doc);
      if (resolved !== null) visit(withRefSiblings(resolved, member), resolved);
    }
  };
  visit(level, level);
  return schemas;
}

/**
 * The schema that supplies one property's own values: description, type,
 * constraints, and element schema. `allOf` members combine those by
 * conjunction, which has no single comparable value, so they supply none —
 * except a one-member `allOf`, which is no conjunction but exactly its member.
 * That member (resolved, with its own `$ref` siblings) supplies the values,
 * with the property's other keywords layered on top as `$ref` siblings are:
 * `{allOf: [{$ref}], description}` is the draft-7 and older-pydantic encoding
 * of `{$ref, description}`.
 */
function valueSchemaOf(schema: JsonSchema, doc: unknown): JsonSchema {
  if (!Array.isArray(schema.allOf) || schema.allOf.length !== 1) return schema;
  const [member] = schema.allOf;
  const resolved = resolveRef(member, doc);
  if (resolved === null) return schema;
  const wrapper = Object.entries(schema).filter(([keyword]) => keyword !== 'allOf');
  return { ...withRefSiblings(resolved, member), ...Object.fromEntries(wrapper) };
}

/**
 * Normalize one property schema, descending into its object fields and array
 * elements. Its values come from `valueSchemaOf`; its structure (fields,
 * `required`, closure) from every unconditional schema at its level.
 */
function propertyFrom(
  name: string,
  rawSchema: unknown,
  placement: Placement,
  doc: unknown,
  depth: number,
  seen: ReadonlySet<object>,
): RenderedProperty {
  const resolved = resolveRef(rawSchema, doc);
  if (resolved === null) {
    return {
      ...placement,
      constraints: {},
      description: null,
      explicitType: null,
      name,
      requiredNames: [],
      type: null,
    };
  }
  const schema = withRefSiblings(resolved, rawSchema);
  const schemas = unconditionalSchemas(schema, doc);
  const values = valueSchemaOf(schema, doc);
  const property: RenderedProperty = {
    ...placement,
    constraints: extractConstraints(values),
    description: typeof values.description === 'string' ? values.description : null,
    explicitType: explicitType(values),
    name,
    requiredNames: requiredNamesOf(schemas),
    type: effectiveType(values, doc),
  };
  // The visited set holds the ref targets on the path down from the tool
  // root, so a loop back to one is caught whatever the reference site layered
  // on top. The tool root is a level, not a property on that path: a property
  // that recurses to it (`$ref: "#"`) expands once before the loop is caught,
  // the same single expansion a recursive `$defs` entry gets.
  if (seen.has(resolved)) return property;
  // A loop stop compares nothing new; a depth stop can leave fields behind.
  if (depth >= MAX_DEPTH) {
    const cut =
      isRecord(values.items) ||
      propertyMaps(schemas, doc).some(({ entries }) => Object.keys(entries).length > 0);
    if (cut) property.depthLimited = true;
    return property;
  }

  const nestedSeen = new Set(seen).add(resolved);
  const children = propertiesOf(schemas, doc, depth + 1, nestedSeen);
  if (children.length > 0) property.children = children;
  // `items: true` accepts any element, like `items: {}`; it normalizes as an untyped element.
  if (isRecord(values.items) || values.items === true) {
    property.items = propertyFrom('[]', values.items, ARRAY_ELEMENT, doc, depth + 1, nestedSeen);
  }
  return property;
}

/**
 * Every `properties` map one level declares, given its unconditional schemas:
 * their own first (the level's, then each `allOf` member's), then those of
 * each of their `anyOf`/`oneOf` branches.
 */
function propertyMaps(
  schemas: JsonSchema[],
  doc: unknown,
): { declaredIn: RenderedProperty['declaredIn']; entries: Record<string, unknown> }[] {
  const maps: ReturnType<typeof propertyMaps> = [];
  for (const schema of schemas) {
    if (isRecord(schema.properties)) maps.push({ declaredIn: 'root', entries: schema.properties });
  }
  for (const schema of schemas) {
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const branches = schema[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        const resolved = resolveRef(branch, doc);
        if (resolved === null || !isRecord(resolved.properties)) continue;
        maps.push({ declaredIn: 'branch', entries: resolved.properties });
      }
    }
  }
  return maps;
}

/**
 * Every property declared at one level, in `propertyMaps` order. An
 * unconditional declaration wins; a repeated name is collected once. A
 * property that any closed unconditional schema rejects is marked `excluded`.
 */
function propertiesOf(
  schemas: JsonSchema[],
  doc: unknown,
  depth: number,
  seen: ReadonlySet<object>,
): RenderedProperty[] {
  const requiredNames = requiredNamesOf(schemas);
  const properties: RenderedProperty[] = [];
  const collected = new Set<string>();
  for (const { declaredIn, entries } of propertyMaps(schemas, doc)) {
    for (const [name, rawSchema] of Object.entries(entries)) {
      if (collected.has(name)) continue;
      collected.add(name);
      const placement: Placement = {
        declaredIn,
        excluded: schemas.some((schema) => rejects(schema, name)),
        required: requiredNames.includes(name),
      };
      properties.push(propertyFrom(name, rawSchema, placement, doc, depth, seen));
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
  return propertiesOf(unconditionalSchemas(resolved, doc), doc, 0, new Set());
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
  const schemas = unconditionalSchemas(schema, doc);
  return {
    description,
    hasRootUnion: Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf),
    name,
    properties: propertiesOf(schemas, doc, 0, new Set()),
    requiredNames: requiredNamesOf(schemas),
  };
}
