<div align="center">
  <h1>mcp-crosscheck</h1>
  <p><b>Test the tool schema your MCP clients actually see.</b></p>
  <p>Run real clients against your server and diff their rendered tool surface against <code>tools/list</code>. No LLM calls.</p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/mcp-crosscheck?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/mcp-crosscheck) [![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933.svg?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE)

</div>

---

An MCP server can advertise a valid JSON Schema and still break after a client converts it to OpenAPI or a function schema. `mcp-crosscheck` captures ground truth with the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), runs real clients against the same server, and reports how their rendered schemas differ.

## Quick start

```sh
# stdio server
npx mcp-crosscheck -- node ./dist/index.js

# running streamable-http server
npx mcp-crosscheck --http https://example.com/mcp

# authenticated streamable-http server
npx mcp-crosscheck --http https://example.com/mcp --header 'Authorization: Bearer dummy'

# verify one safe tool call with exact arguments
npx mcp-crosscheck --canary 'echo_message={"message":"probe"}' -- node ./dist/index.js

# include the opt-in agent CLI adapters
npx mcp-crosscheck --adapters inspector,mcpo,codex,claude-code -- node ./dist/index.js
```

Requires Node 22 or newer. The mcpo adapter also requires [`uv`](https://docs.astral.sh/uv/) on `PATH`.
Windows support is verified on Node 22.21.0, including the built CLI, stdio fixture, timeout handling, and descendant process cleanup.

Exit codes: `0` pass, `1` findings or runtime failure, `2` usage error.

## What it catches

| Tier | Findings |
|:--|:--|
| **fail** | Missing tools or input properties; input properties a rendered `additionalProperties: false` excludes; empty request bodies; properties that lose their advertised type information or change their explicit type; descriptions rendered missing or blank; lost `required` markers; adapter launch, MCP handshake, or canary failures; a `tools/list` walk that stops before the server's last page |
| **info** | Dropped constraints such as `enum`, `minimum`, and `pattern`, or changed constraint values; truncated or rewritten descriptions; ignored root `anyOf`/`oneOf`; missing, untyped, or explicitly retyped `outputSchema` fields; a root `$schema` naming a dialect the MCP TypeScript SDK v2 client does not recognize (anything but 2020-12, 2019-09, draft-07, and draft-06; it rejects every call to a tool whose `outputSchema` declares one); a tool definition that clients on `@modelcontextprotocol/sdk` 1.x reject, such as a boolean property schema or a non-object `outputSchema` root, which makes them reject the whole `tools/list` result |

Input checks recurse through nested objects and array items, including fields declared in `allOf` members and `anyOf`/`oneOf` branches. When an adapter exposes a result model, output-schema drift stays informational because it can mislead a model about a result but does not drop an argument.

Comparison is bounded in depth: a property more than seven levels below a tool's root (or its `outputSchema` root) is not compared. Where that cuts off fields the schema still declares, the report names the deepest compared path under `groundTruth.depthLimitedPaths`. A `$ref` that loops back to a schema already on the path is not listed: that schema was compared where it first appeared.

Some checks read the advertised surface alone, such as the `$schema` dialect or a tool definition SDK 1.x rejects. Their notes are the same for every client, so they appear once, under `groundTruth.findings` and in a ground-truth block above the adapters. They count toward the info total, never fail a run, and are never written to a baseline. A tool SDK 1.x rejects is still captured and compared like any other, and a boolean property schema compares as an untyped property.

Ground truth follows `tools/list` pagination for up to 100 pages. The walk stops early when a `nextCursor` repeats a cursor already sent, or when the page cap is reached with a `nextCursor` still unfollowed. It never requests a page twice. The report then names the reason and page count under `groundTruth.truncation`, and the run fails even with no findings, because tools past the pages read were never compared.

The optional canary uses one tool and the exact arguments you provide. Crosscheck first calls it through the official MCP SDK client, listing `tools/list` up to the page that advertises the tool, so the SDK checks the result's `structuredContent` against the tool's `outputSchema`. If that call fails, the run stops with exit `2` before any adapter starts. Otherwise the call is repeated through each adapter that supports calls. Crosscheck never invents a tool call.

## Adapters

| Adapter | Default | Targets | What is captured |
|:--|:--:|:--|:--|
| [MCP Inspector](https://github.com/modelcontextprotocol/inspector) | yes | stdio, HTTP | Verbatim `tools/list` plus an optional canary call |
| [mcpo](https://github.com/open-webui/mcpo) | yes | stdio, HTTP | Generated OpenAPI document plus an optional POST canary |
| [Codex CLI](https://github.com/openai/codex) | no | stdio, HTTP | Converted function schemas from a local provider intercept; capture-only |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | no | stdio | Converted input schemas from an isolated local base-URL intercept; capture-only |

Codex runs with a clean environment and throwaway `HOME`/`CODEX_HOME`. HTTP header values reach Codex through generated environment-variable names referenced by its isolated TOML. Claude Code runs with isolated `HOME` and `CLAUDE_CONFIG_DIR`, `--bare`, dummy auth, and a loopback-only model endpoint. Both stop after the tools-bearing request is captured, without logging in or contacting a model service. See [adapter profiles and frozen measurements](docs/adapters.md) for the tested versions and schema evidence.

Package-backed adapters resolve their latest release by default. Claude Code exercises the installed `claude` executable (on Windows, the native installer's `claude.exe`) and reports its actual version. A `claude-code` pin is an exact requirement: the adapter reports `adapter-broken` without launching when the installed version differs. Pin versions when you need a fixed comparison:

```sh
mcp-crosscheck --pin mcpo=0.0.20 --mcpo-with 'mcp<2' -- node ./dist/index.js
```

## CLI

```
mcp-crosscheck [flags] -- <command> [args...]     # stdio
mcp-crosscheck --http <url> [flags]               # streamable HTTP
```

| Flag | Purpose |
|:--|:--|
| `--adapters <a,b,c>` | Select adapters. Default: `inspector,mcpo`. |
| `--canary '<tool>={json}'` | Round-trip one safe tool with exact arguments. |
| `--env <K=V>` | Add an environment variable to the stdio server. Repeatable; stdio only. |
| `--header <Name: value>` | Add an HTTP target header. Repeatable; `--http` only. |
| `--pin <name=version>` | Pin an adapter version. Repeatable. |
| `--mcpo-with <spec>` | Add an `uvx --with` constraint for mcpo. Repeatable. |
| `--artifacts <dir>` | Save ground truth, raw adapter captures, and `report.json`. |
| `--timeout <seconds>` | Set the per-stage timeout, from `0.001` to `2147483.647` (the Node timer limit). Default: `120`. |
| `--baseline <file>` | Acknowledge matching reviewed rendering drift from a strict v1 baseline. |
| `--update-baseline` | Replace entries for selected adapters that completed a safe comparison. Requires `--baseline`. |
| `--json` | Write exactly one JSON document to stdout: the report, or an error document when the run ends without one. Progress stays on stderr. |
| `-h`, `--help` | Print CLI usage. |
| `-V`, `--version` | Print the package version. |

Header names are unique case-insensitively. Values are removed from the free text crosscheck writes: finding details, adapter status and canary details, progress lines, and error messages. Structured fields keep their values, so a short value such as `on` never rewrites a rule id or a baseline entry. Those fields are the target URL, server and tool names, rule ids, paths, evidence, and versions. The command line itself can be visible through shell history or process inspection. Inspector and mcpo also receive headers in child-process arguments. Use dummy credentials in tests when possible.

Every `--json` document carries `reportVersion: 1`. Besides the per-adapter results, a report's `groundTruth` block carries `findings` (notes about the advertised surface itself), `depthLimitedPaths` (where comparison stopped at the depth limit), and `truncation`: `null` when `tools/list` was read to its last page, otherwise `{ "pagesRead": n, "reason": "cursor-repeated" | "page-cap" }`. `pass` is true only when `failCount` is `0` and `truncation` is `null`. A run that ends without a report prints `{ "reportVersion": 1, "error": { "kind": "usage" | "runtime", "message": "…" } }` and exits `2` for `usage` or `1` for `runtime`. The message is redacted like every other diagnostic. JSON mode applies whenever `--json` is passed as a flag, even when other flags fail to parse; a `--json` after the `--` separator belongs to the server command. `--help` and `--version` always print text.

## Baselines

A baseline acknowledges rendering drift you have reviewed. It does not suppress adapter startup, handshake, canary, ground-truth, or run failures.

```sh
# create or refresh reviewed entries after an eligible run
mcp-crosscheck --baseline ./crosscheck-baseline.json --update-baseline -- node ./dist/index.js

# later runs fail only on new rendering drift
mcp-crosscheck --baseline ./crosscheck-baseline.json -- node ./dist/index.js
```

Updates replace entries only for selected adapters that returned a surface; unselected entries stay intact. Any selected runtime or canary failure, or a truncated `tools/list` walk, leaves the file byte-for-byte unchanged. A truncated run also reports no stale entries, since tools past the pages read were never compared. A successful update is reconciled against the new file immediately, so accepted findings do not make the update command fail. Stale entries are informational and remain in read-only mode until the next eligible update.

An entry records a finding's identity: its adapter, rule, path, and evidence, never its wording. Findings that share an identity share one entry; a dotted tool or property name can make two paths alike. Entries are sorted by code unit, so a rewrite produces the same bytes on every machine.

## Programmatic API

```ts
import { runCrosscheck } from 'mcp-crosscheck';

const report = await runCrosscheck({
  adapters: ['inspector', 'mcpo'],
  target: { kind: 'stdio', command: 'node', args: ['./dist/index.js'], env: {} },
});

console.log(report.pass, report.failCount);
```

For stdio targets, command and argument tokens beginning with `./` or `../` (and `.\` or `..\`
on Windows) are resolved lexically against the invoking process's current directory. Adapters
still run their package runners from a neutral scratch directory so local manifests cannot shadow
the selected client.

Caller mistakes reject with `CrosscheckUsageError` before any process starts: an unknown or
repeated adapter name, a pin for an unknown adapter, an HTTP target URL that is not `http:` or
`https:`, or a `timeoutMs` outside 1 to 2147483647.

The package also exports the ground-truth capture, schema normalizers, comparison engine, adapter parsers, and report renderers.

## Development

```sh
bun install
bun run devcheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow, opt-in client lanes, and adapter constraints.

All `--artifacts` output is local-sensitive. `ground-truth.json` and `mcpo.openapi.json` can contain server-controlled data; raw `codex.request.json` and `claude-code.request.json` can also contain prompt, session, and client metadata. Exact header-value redaction applies to the free text of crosscheck-owned diagnostics and reports, not to their structured fields, arbitrary server echoes, or raw captures.

The default suite is hermetic. Set `CROSSCHECK_E2E_NETWORK=1` to exercise Inspector and mcpo at their current releases, `CROSSCHECK_E2E_CODEX=1` for Codex, or `CROSSCHECK_E2E_CLAUDE_CODE=1` for the installed Claude Code client.

## License

Apache 2.0. See [LICENSE](./LICENSE).
