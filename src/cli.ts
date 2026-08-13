#!/usr/bin/env node
/**
 * @file src/cli.ts
 * CLI entry: argument parsing, progress on stderr, report on stdout.
 * Exit codes: 0 = pass, 1 = failures (or fatal error), 2 = usage error.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_ADAPTERS, isAdapterName } from './adapters/index.js';
import { parseHttpHeaders } from './cli-args.js';
import { renderHumanReport, toJsonReport } from './report.js';
import { CrosscheckUsageError, runCrosscheck } from './run.js';
import type { AdapterName, CanarySpec, TargetSpec } from './types.js';
import { VERSION } from './version.js';

const USAGE = `mcp-crosscheck v${VERSION}
Run real MCP clients against your built server and verify the tool surface
they actually render. No model inference or non-loopback provider traffic.

Usage:
  mcp-crosscheck [flags] -- <command> [args...]     stdio server under test
  mcp-crosscheck --http <url> [flags]               running streamable-http server

Flags:
  --adapters <a,b,c>   Adapters: inspector, mcpo, codex, claude-code.
                       Default: inspector,mcpo. Agent CLI captures are opt-in and use
                       local intercepts without login or non-loopback API traffic.
  --canary '<tool>={json}'
                       Safe tool to round-trip through each adapter with exactly these
                       args (e.g. --canary 'echo_message={"message":"probe"}').
                       Verified against ground truth first. Never synthesized.
  --env <K=V>          Environment variable for the spawned server (repeatable).
  --header <Name: value>
                       HTTP request header for the target (repeatable; HTTP only).
  --pin <name=version> Pin an adapter version (repeatable), e.g. --pin mcpo=0.0.20.
                       claude-code requires the installed version to match its pin.
  --mcpo-with <spec>   Extra uvx --with dependency constraint for mcpo (repeatable),
                       e.g. --mcpo-with 'mcp<2'.
  --artifacts <dir>    Save the report and raw captures (report.json, ground truth,
                       openapi.json, codex request, claude-code request).
  --timeout <seconds>  Per-stage timeout. Default: 120.
  --baseline <file>    Acknowledge matching reviewed rendering drift (read-only).
  --update-baseline    Replace selected successful adapter entries after the run.
  --json               Machine-readable report on stdout.
  -h, --help           This help.
  -V, --version        Print version.

Exit codes: 0 pass · 1 failures · 2 usage error.`;

function parseCanary(raw: string): CanarySpec {
  const separator = raw.indexOf('=');
  if (separator <= 0) {
    throw new CrosscheckUsageError(`--canary must be '<tool>={json}', got: ${raw}`);
  }
  const tool = raw.slice(0, separator);
  const argsRaw = raw.slice(separator + 1);
  let args: unknown;
  try {
    args = JSON.parse(argsRaw);
  } catch {
    throw new CrosscheckUsageError(`--canary args are not valid JSON: ${argsRaw}`);
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new CrosscheckUsageError('--canary args must be a JSON object');
  }
  return { args: args as Record<string, unknown>, tool };
}

function parseKeyValue(raw: string, flag: string): [string, string] {
  const separator = raw.indexOf('=');
  if (separator <= 0) {
    throw new CrosscheckUsageError(`${flag} must be KEY=VALUE, got: ${raw}`);
  }
  return [raw.slice(0, separator), raw.slice(separator + 1)];
}

function parseAdapters(raw: string): AdapterName[] {
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) {
    throw new CrosscheckUsageError('--adapters was given but names no adapters');
  }
  return names.map((name) => {
    if (!isAdapterName(name)) {
      throw new CrosscheckUsageError(
        `unknown adapter "${name}" — known adapters: inspector, mcpo, codex, claude-code`,
      );
    }
    return name;
  });
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      adapters: { type: 'string' },
      artifacts: { type: 'string' },
      baseline: { type: 'string' },
      canary: { type: 'string' },
      env: { multiple: true, type: 'string' },
      help: { short: 'h', type: 'boolean' },
      header: { multiple: true, type: 'string' },
      http: { type: 'string' },
      json: { type: 'boolean' },
      'mcpo-with': { multiple: true, type: 'string' },
      pin: { multiple: true, type: 'string' },
      timeout: { type: 'string' },
      'update-baseline': { type: 'boolean' },
      version: { short: 'V', type: 'boolean' },
    },
  });

  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  if (values.version === true) {
    console.log(VERSION);
    return 0;
  }

  const env = Object.fromEntries((values.env ?? []).map((entry) => parseKeyValue(entry, '--env')));
  let headers: Record<string, string>;
  try {
    headers = parseHttpHeaders(values.header ?? []);
  } catch (error) {
    throw new CrosscheckUsageError(error instanceof Error ? error.message : String(error));
  }

  if (values['update-baseline'] === true && values.baseline === undefined) {
    throw new CrosscheckUsageError('--update-baseline requires --baseline <file>');
  }

  let target: TargetSpec;
  if (values.http !== undefined) {
    if (positionals.length > 0) {
      throw new CrosscheckUsageError('--http and a stdio command are mutually exclusive');
    }
    target = { headers, kind: 'http', url: values.http };
  } else {
    if (values.header !== undefined) {
      throw new CrosscheckUsageError('--header is supported only with --http');
    }
    const [command, ...args] = positionals;
    if (command === undefined) {
      throw new CrosscheckUsageError(
        'no target — pass a stdio command after `--`, or --http <url> (see --help)',
      );
    }
    target = { args, command, env, kind: 'stdio' };
  }

  const pins: Partial<Record<AdapterName, string>> = {};
  for (const entry of values.pin ?? []) {
    const [name, version] = parseKeyValue(entry, '--pin');
    if (!isAdapterName(name)) {
      throw new CrosscheckUsageError(`--pin names unknown adapter "${name}"`);
    }
    pins[name] = version;
  }

  const timeoutSeconds = values.timeout === undefined ? 120 : Number(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new CrosscheckUsageError(`--timeout must be a positive number of seconds`);
  }

  const report = await runCrosscheck({
    adapters: values.adapters === undefined ? DEFAULT_ADAPTERS : parseAdapters(values.adapters),
    artifactsDir: values.artifacts ?? null,
    baselinePath: values.baseline ?? null,
    canary: values.canary === undefined ? null : parseCanary(values.canary),
    log: (line) => console.error(`[crosscheck] ${line}`),
    mcpoWith: values['mcpo-with'] ?? [],
    pins,
    target,
    timeoutMs: Math.round(timeoutSeconds * 1000),
    updateBaseline: values['update-baseline'] === true,
  });

  if (values.artifacts !== undefined) {
    await writeFile(join(values.artifacts, 'report.json'), toJsonReport(report));
  }
  console.log(values.json === true ? toJsonReport(report) : renderHumanReport(report));
  return report.pass ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CrosscheckUsageError) {
      console.error(`mcp-crosscheck: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`mcp-crosscheck: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
