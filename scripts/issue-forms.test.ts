import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const templateDir = new URL('../.github/ISSUE_TEMPLATE/', import.meta.url);

function readYaml(name: string): Record<string, unknown> {
  return Bun.YAML.parse(readFileSync(new URL(name, templateDir), 'utf8')) as Record<
    string,
    unknown
  >;
}

function fields(form: Record<string, unknown>) {
  return form.body as Array<{
    type: string;
    id?: string;
    attributes: Record<string, unknown>;
  }>;
}

function expectValidFields(form: Record<string, unknown>): string[] {
  const interactive = fields(form).filter((field) => field.type !== 'markdown');
  const ids = interactive.map((field) => field.id ?? '');
  expect(ids.every((id) => id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  expect(
    interactive.every(
      (field) =>
        typeof field.attributes.label === 'string' && field.attributes.label.trim().length > 0,
    ),
  ).toBe(true);
  return ids;
}

describe('GitHub issue forms', () => {
  test('bug reports are reproducible and secret-safe', () => {
    const form = readYaml('bug_report.yml');
    const body = fields(form);
    expectValidFields(form);

    expect(form.labels).toEqual(['bug']);
    expect(form.assignees).toEqual(['cyanheads']);
    expect(body.find((field) => field.id === 'adapter')?.attributes.options).toContain(
      'Not adapter-specific',
    );
    expect(body.find((field) => field.id === 'report')?.attributes.description).toContain(
      'before a report was produced',
    );
    expect(body.find((field) => field.id === 'redaction')?.attributes.options).toEqual([
      expect.objectContaining({ required: true }),
    ]);
    expect(readFileSync(new URL('bug_report.yml', templateDir), 'utf8')).toContain(
      'Raw `--artifacts` captures are local-sensitive',
    );
  });

  test('adapter requests enforce deterministic local capture', () => {
    const form = readYaml('adapter_request.yml');
    const ids = expectValidFields(form);

    expect(form.labels).toEqual(['adapter']);
    expect(form.assignees).toEqual(['cyanheads']);
    expect(ids).toEqual(
      expect.arrayContaining([
        'release_source',
        'transports',
        'rendered_surface',
        'version_resolution',
        'capture_path',
        'prerequisites',
        'limitations',
        'deterministic_boundary',
      ]),
    );
    expect(readFileSync(new URL('adapter_request.yml', templateDir), 'utf8')).toContain(
      'no account, tokens, model inference, or non-loopback provider traffic',
    );
  });

  test('the chooser keeps only live routing', () => {
    const config = readYaml('config.yml');
    const links = config.contact_links as Array<{ url: string }>;

    expect(config.blank_issues_enabled).toBe(false);
    expect(links).toEqual([
      expect.objectContaining({ url: 'https://github.com/cyanheads/mcp-crosscheck#readme' }),
    ]);
    expect(JSON.stringify(config)).not.toContain('discussions');
  });
});
