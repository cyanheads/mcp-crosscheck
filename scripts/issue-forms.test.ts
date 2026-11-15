import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

const githubDir = new URL('../.github/', import.meta.url);
const templateDir = new URL('ISSUE_TEMPLATE/', githubDir);

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
    validations?: { required?: boolean };
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
    const ids = expectValidFields(form);

    expect(form.labels).toEqual(['bug']);
    expect(form.assignees).toEqual(['cyanheads']);
    expect(ids).toEqual(
      expect.arrayContaining(['description', 'reproduction', 'report', 'actual', 'expected']),
    );
    expect(body.find((field) => field.id === 'context')?.validations?.required).toBe(false);
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

    expect(form.labels).toEqual(['enhancement', 'adapter']);
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

  test('the chooser routes security reports privately and links no disabled surface', () => {
    const config = readYaml('config.yml');
    const links = config.contact_links as Array<{ url: string }>;

    expect(config.blank_issues_enabled).toBe(true);
    expect(links.map((link) => link.url)).toEqual([
      'https://github.com/cyanheads/mcp-crosscheck/security/advisories/new',
      'https://github.com/cyanheads/mcp-crosscheck#readme',
    ]);
    expect(JSON.stringify(config)).not.toContain('discussions');
  });

  test('the contributing guide links every form, and the bug form links back to it', () => {
    const contributing = readFileSync(new URL('CONTRIBUTING.md', githubDir), 'utf8');
    const linked = [...contributing.matchAll(/issues\/new\?template=([\w-]+\.yml)/g)].map(
      (match) => match[1],
    );
    const forms = readdirSync(templateDir).filter(
      (name) => name.endsWith('.yml') && name !== 'config.yml',
    );

    expect(linked.toSorted()).toEqual(forms.toSorted());
    expect(contributing).toMatch(/^## Before filing$/m);
    expect(readFileSync(new URL('bug_report.yml', templateDir), 'utf8')).toContain(
      '/.github/CONTRIBUTING.md#before-filing',
    );
  });
});
