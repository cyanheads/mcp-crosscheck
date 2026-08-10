/**
 * @file src/schema.ts
 * JSON Schema normalization: turns any JSON-Schema-shaped tool input (ground
 * truth, MCP Inspector output, Codex function parameters) into the comparable
 * `RenderedTool` model. Local `$ref`s are resolved against the containing
 * document; remote refs are left untouched.
 */
import type { JsonSchema, RenderedProperty, RenderedTool } from './types.js';

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

/** Extract the constraint keywords present on a property schema. */
export function extractConstraints(schema: JsonSchema): Record<string, unknown> {
  const constraints: Record<string, unknown> = {};
  for (const keyword of CONSTRAINT_KEYWORDS) {
    if (schema[keyword] !== undefined) constraints[keyword] = schema[keyword];
  }
  return constraints;
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
  const rawProperties = isRecord(schema.properties) ? schema.properties : {};
  const requiredNames = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const hasRootUnion = Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf);

  const properties: RenderedProperty[] = Object.entries(rawProperties).map(
    ([propertyName, rawSchema]) => {
      const resolved = resolveRef(rawSchema, doc);
      if (resolved === null) {
        return {
          constraints: {},
          description: null,
          name: propertyName,
          required: requiredNames.includes(propertyName),
          type: null,
        };
      }
      return {
        constraints: extractConstraints(resolved),
        description: typeof resolved.description === 'string' ? resolved.description : null,
        name: propertyName,
        required: requiredNames.includes(propertyName),
        type: effectiveType(resolved, doc),
      };
    },
  );

  return { description, hasRootUnion, name, properties, requiredNames };
}
