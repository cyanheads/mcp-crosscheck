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
import { renderHumanReport, toJsonReport } from './report.js';
import { CrosscheckUsageError, runCrosscheck } from './run.js';
import type { AdapterName, CanarySpec, TargetSpec } from './types.js';
import { VERSION } from './version.js';

const USAGE = `mcp-crosscheck v${VERSION}
Run real MCP clients against your built server and verify the tool surface
they actually render. Deterministic: no LLM calls, no API keys.

Usage:
  mcp-crosscheck [flags] -- <command> [args...]     stdio server under test
  mcp-crosscheck --http <url> [flags]               running streamable-http server

Flags:
  --adapters <a,b,c>   Adapters to run (inspector, mcpo, codex). Default: inspector,mcpo.
                       codex is opt-in: it boots the real Codex CLI against a local
                       intercept — no login, no API traffic — but only runs when named.
  --canary '<tool>={json}'
                       Safe tool to round-trip through each adapter with exactly these
                       args (e.g. --canary 'echo_message={"message":"probe"}').
                       Verified against ground truth first. Never synthesized.
  --env <K=V>          Environment variable for the spawned server (repeatable).
  --pin <name=version> Pin an adapter version instead of latest (repeatable),
                       e.g. --pin mcpo=0.0.20.
  --mcpo-with <spec>   Extra uvx --with dependency constraint for mcpo (repeatable),
                       e.g. --mcpo-with 'mcp<2'.
  --artifacts <dir>    Save raw captures (ground truth, openapi.json, codex request).
  --timeout <seconds>  Per-stage timeout. Default: 120.
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
        `unknown adapter "${name}" — known adapters: inspector, mcpo, codex`,
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
      canary: { type: 'string' },
      env: { multiple: true, type: 'string' },
      help: { short: 'h', type: 'boolean' },
      http: { type: 'string' },
      json: { type: 'boolean' },
      'mcpo-with': { multiple: true, type: 'string' },
      pin: { multiple: true, type: 'string' },
      timeout: { type: 'string' },
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

  let target: TargetSpec;
  if (values.http !== undefined) {
    if (positionals.length > 0) {
      throw new CrosscheckUsageError('--http and a stdio command are mutually exclusive');
    }
    target = { kind: 'http', url: values.http };
  } else {
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
    canary: values.canary === undefined ? null : parseCanary(values.canary),
    log: (line) => console.error(`[crosscheck] ${line}`),
    mcpoWith: values['mcpo-with'] ?? [],
    pins,
    target,
    timeoutMs: Math.round(timeoutSeconds * 1000),
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
