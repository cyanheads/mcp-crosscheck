/** @file src/cli-args.ts Pure parsing for repeatable HTTP target header arguments. */

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

function validateHttpHeaderEntries(
  entries: Iterable<readonly [string, unknown]>,
): Record<string, string> {
  const validated: [string, string][] = [];
  const names = new Set<string>();
  for (const [name, value] of entries) {
    if (name === '' || !HEADER_NAME.test(name)) {
      throw new Error('HTTP header name must be a valid field name');
    }
    if (typeof value !== 'string') {
      throw new Error('HTTP header value must be a non-empty valid field value');
    }
    const hasInvalidValueCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint < 0x20 && codePoint !== 0x09) || codePoint === 0x7f;
    });
    if (value.trim() === '' || hasInvalidValueCharacter) {
      throw new Error('HTTP header value must be a non-empty valid field value');
    }
    const canonicalName = name.toLowerCase();
    if (names.has(canonicalName)) {
      throw new Error(`HTTP header names must be unique (duplicate: ${name})`);
    }
    names.add(canonicalName);
    validated.push([name, value]);
  }
  return Object.fromEntries(validated);
}

/** Validate a programmatic HTTP header map and return a safe plain object in input order. */
export function validateHttpHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new Error('HTTP headers must be a name/value map');
  }
  return validateHttpHeaderEntries(Object.entries(headers));
}

/** Parse `Name: value` arguments without including supplied values in diagnostics. */
export function parseHttpHeaders(rawHeaders: string[]): Record<string, string> {
  const entries: [string, string][] = [];
  for (const raw of rawHeaders) {
    const separator = raw.indexOf(':');
    if (separator === -1) {
      throw new Error('--header must contain a name and value separated by `:`');
    }
    const name = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim();
    entries.push([name, value]);
  }
  try {
    return validateHttpHeaderEntries(entries);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--header ${message.replace(/^HTTP header /, '')}`);
  }
}
