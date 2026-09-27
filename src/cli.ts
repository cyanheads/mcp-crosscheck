#!/usr/bin/env node
/**
 * @file src/cli.ts
 * CLI entry: argument parsing, progress on stderr, report on stdout.
 * Exit codes: 0 = pass, 1 = failures (or fatal error), 2 = usage error.
 * With `--json`, every run writes exactly one JSON document to stdout.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';

import { DEFAULT_ADAPTERS, isAdapterName } from './adapters/index.js';
import { parseHttpHeaders } from './cli-args.js';
import { createRedactor } from './redact.js';
import { renderHumanReport, toJsonError, toJsonReport } from './report.js';
import { CrosscheckUsageError, MAX_TIMEOUT_MS, runCrosscheck } from './run.js';
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
  --env <K=V>          Environment variable for the spawned server (repeatable; stdio only).
  --header <Name: value>
                       HTTP request header for the target (repeatable; HTTP only).
  --pin <name=version> Pin an adapter version (repeatable), e.g. --pin mcpo=0.0.20.
                       claude-code requires the installed version to match its pin.
  --mcpo-with <spec>   Extra uvx --with dependency constraint for mcpo (repeatable),
                       e.g. --mcpo-with 'mcp<2'.
  --artifacts <dir>    Save the report and raw captures: report.json, ground-truth.json,
                       mcpo.openapi.json, codex.request.json, claude-code.request.json.
  --timeout <seconds>  Per-stage timeout, 0.001 to ${MAX_TIMEOUT_MS / 1000}. Default: 120.
  --baseline <file>    Acknowledge matching reviewed rendering drift (read-only).
  --update-baseline    Replace selected successful adapter entries after the run.
  --json               One JSON document on stdout: the report, or an error document
                       when the run ends without one.
  -h, --help           This help.
  -V, --version        Print version.

Exit codes: 0 pass · 1 failures · 2 usage error.`;

const OPTIONS = {
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
} as const satisfies ParseArgsOptionsConfig;

/**
 * Whether this run answers in JSON: a `--json` token, in any form, before the
 * `--` terminator. A raw scan decides rather than a parse, so a flag-parse
 * error still answers in JSON, even a string flag missing its value right
 * before `--json` — a lenient parse would read `--json` as that value, which
 * the strict parse never accepts. A `--json` after `--` belongs to the server command.
 */
function jsonRequested(args: string[]): boolean {
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).some(
    (arg) => arg === '--json' || arg.startsWith('--json='),
  );
}

/** Strict flag parse. An unknown flag, a missing value, or a value on a switch is a usage error. */
function parseFlags(args: string[]) {
  try {
    return parseArgs({ allowPositionals: true, args, options: OPTIONS });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('ERR_PARSE_ARGS_')
    ) {
      throw new CrosscheckUsageError(error.message);
    }
    throw error;
  }
}

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

/** `--timeout` seconds as timer milliseconds, within the range Node timers honor. */
function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return 120_000;
  const milliseconds = Number(raw) * 1000;
  if (!(milliseconds >= 1 && milliseconds <= MAX_TIMEOUT_MS)) {
    throw new CrosscheckUsageError(
      `--timeout must be a number of seconds from 0.001 to ${MAX_TIMEOUT_MS / 1000} (about 24.8 days), got: ${raw}`,
    );
  }
  return Math.round(milliseconds);
}

async function main(args: string[]): Promise<number> {
  const json = jsonRequested(args);
  let redact = (text: string) => text;
  try {
    const { positionals, values } = parseFlags(args);

    if (values.help === true) {
      console.log(USAGE);
      return 0;
    }
    if (values.version === true) {
      console.log(VERSION);
      return 0;
    }

    let headers: Record<string, string>;
    try {
      headers = parseHttpHeaders(values.header ?? []);
    } catch (error) {
      throw new CrosscheckUsageError(error instanceof Error ? error.message : String(error));
    }
    redact = createRedactor(Object.values(headers));

    if (values['update-baseline'] === true && values.baseline === undefined) {
      throw new CrosscheckUsageError('--update-baseline requires --baseline <file>');
    }

    let target: TargetSpec;
    if (values.http !== undefined) {
      if (positionals.length > 0) {
        throw new CrosscheckUsageError('--http and a stdio command are mutually exclusive');
      }
      if (values.env !== undefined) {
        throw new CrosscheckUsageError('--env is supported only with a stdio target');
      }
      target = { headers, kind: 'http', url: values.http };
    } else {
      if (values.header !== undefined) {
        throw new CrosscheckUsageError('--header is supported only with --http');
      }
      const [command, ...commandArgs] = positionals;
      if (command === undefined) {
        throw new CrosscheckUsageError(
          'no target — pass a stdio command after `--`, or --http <url> (see --help)',
        );
      }
      const env = Object.fromEntries(
        (values.env ?? []).map((entry) => parseKeyValue(entry, '--env')),
      );
      target = { args: commandArgs, command, env, kind: 'stdio' };
    }

    const pins: Partial<Record<AdapterName, string>> = {};
    for (const entry of values.pin ?? []) {
      const [name, version] = parseKeyValue(entry, '--pin');
      if (!isAdapterName(name)) {
        throw new CrosscheckUsageError(`--pin names unknown adapter "${name}"`);
      }
      pins[name] = version;
    }

    const timeoutMs = parseTimeoutMs(values.timeout);
    const report = await runCrosscheck({
      adapters: values.adapters === undefined ? DEFAULT_ADAPTERS : parseAdapters(values.adapters),
      artifactsDir: values.artifacts ?? null,
      baselinePath: values.baseline ?? null,
      canary: values.canary === undefined ? null : parseCanary(values.canary),
      log: (line) => console.error(`[crosscheck] ${line}`),
      mcpoWith: values['mcpo-with'] ?? [],
      pins,
      target,
      timeoutMs,
      updateBaseline: values['update-baseline'] === true,
    });

    if (values.artifacts !== undefined) {
      await writeFile(join(values.artifacts, 'report.json'), toJsonReport(report));
    }
    console.log(json ? toJsonReport(report) : renderHumanReport(report));
    return report.pass ? 0 : 1;
  } catch (error) {
    const usage = error instanceof CrosscheckUsageError;
    const message = redact(error instanceof Error ? error.message : String(error));
    console.error(`mcp-crosscheck: ${message}`);
    if (json) console.log(toJsonError(usage ? 'usage' : 'runtime', message));
    return usage ? 2 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
