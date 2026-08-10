<div align="center">
  <h1>mcp-crosscheck</h1>
  <p><b>Run real MCP clients against your server and diff what they render against what you advertise.</b></p>
  <p>Deterministic — no LLM calls, no API keys, no accounts. Every check is a process spawn and a JSON read.</p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.0.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![npm](https://img.shields.io/npm/v/mcp-crosscheck?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/mcp-crosscheck) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933.svg?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-%5E1.30.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-%5E7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)

</div>

---

Your MCP server advertises tools over `tools/list`. Each client then re-renders that JSON Schema into its own model — an OpenAPI request body, an OpenAI function schema, a Gemini declaration — and every converter silently drops or mangles what it doesn't handle. Server test suites validate what you advertise; nothing validates what clients actually render. That gap ships real bugs:

- [obsidian-mcp-server#91](https://github.com/cyanheads/obsidian-mcp-server/issues/91) — mcpo's converter had no `oneOf` branch, so a discriminated-union parameter rendered with no type at all, and every downstream layer coerced it to a string.
- [openstreetmap-mcp-server#57](https://github.com/cyanheads/openstreetmap-mcp-server/issues/57) — mcpo builds request models from `properties`/`required` only, so fields declared inside root `anyOf` branches produced `requestBody: null` and every argument was silently dropped.

`mcp-crosscheck` closes the gap. It boots your built server, captures ground truth with the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) client, launches real third-party clients at their latest released versions against the same server, and diffs each client's rendered surface against ground truth. It catches drift in both directions: a schema idiom you ship that a converter mangles, and a converter release that breaks rendering with no change on your side.

## Quick start

```sh
# stdio server — canary names a safe tool to round-trip, with exact args
bunx mcp-crosscheck \
  --env MCP_LOG_LEVEL=error \
  --canary 'echo_message={"message":"probe"}' \
  -- node ./dist/index.js

# already-running streamable-http server
bunx mcp-crosscheck --http https://example.com/mcp

# opt in to the Codex adapter
bunx mcp-crosscheck --adapters inspector,mcpo,codex -- node ./dist/index.js
```

`npx mcp-crosscheck` works identically — the CLI runs on Node ≥ 22, no Bun required. The mcpo adapter needs [`uv`](https://docs.astral.sh/uv/) on PATH; the inspector and codex adapters resolve through `npx`.

Real output against a live server (mcp-ts-core's examples server, 2026-08-09):

```
mcp-crosscheck v0.0.1 → example-mcp-server@0.1.0 (6 tools advertised)

inspector (v2.1.0, 3.8s) PASS
  rendered 6/6 tools
  canary: round-trip ok
  no divergence from ground truth

mcpo (v0.0.20, 1.5s) PASS
  rendered 6/6 tools
  canary: round-trip ok
  info [constraint-dropped] template_echo_message.message constraint keywords dropped: maxLength, minLength
  info [constraint-dropped] template_echo_message.mode constraint keyword dropped: enum
  ...

codex (v0.147.0, 2.8s) PASS
  rendered 6/6 tools
  canary: skipped — codex adapter is capture-only
  info [constraint-dropped] template_echo_message.message constraint keywords dropped: maxLength, minLength
  ...

PASS — 3 adapter(s), 11 info note(s)
```

The same run already tells you things the docs of those clients don't: mcpo drops `enum` from rendered models, Codex keeps `enum` but strips `minimum`/`maximum`, and both lose string length bounds. Exit codes: `0` pass · `1` failures · `2` usage error.

## What it checks

Two severity tiers. `fail` is divergence that breaks agents in the wild; `info` is recorded degradation that never fails a run.

| Tier | Invariants |
|:--|:--|
| **fail** | tool missing from the rendered surface · property missing · property rendered with no type information · tool or property description lost · root `required` dropped · empty request body for a tool that advertises properties · canary round-trip fails through the adapter · MCP handshake failure · `adapter-broken` (the client itself failed to launch, reported with its resolved version) |
| **info** | dropped constraint keywords (`minimum`, `maximum`, `pattern`, `format`, `enum`, `minLength`, `maxLength`, `additionalProperties`, …) · root `anyOf`/`oneOf` union a client ignores rather than enforces |

The canary is never synthesized: you name one safe tool and its exact arguments, crosscheck verifies the call against ground truth first, and only then round-trips it through each adapter. A canary that fails against your own server is a usage error, not a client bug.

## Adapters

| Adapter | Runs | Rendered surface | Notes |
|:--|:--|:--|:--|
| [MCP Inspector](https://github.com/modelcontextprotocol/inspector) | `npx @modelcontextprotocol/inspector --cli` | verbatim `tools/list` | The protocol-handshake baseline. stdio and streamable-http. |
| [mcpo](https://github.com/open-webui/mcpo) | `uvx mcpo` | generated `openapi.json` + live POST canary | open-webui's MCP → OpenAPI proxy. stdio and streamable-http. |
| [Codex CLI](https://github.com/openai/codex) | `npx @openai/codex exec` under a throwaway `CODEX_HOME` | intercepted Responses API request body | **Opt-in.** stdio targets. Capture-only (no canary). |

**Latest floats by design.** Adapters resolve `@latest` at run time — a crosscheck run is a canary, not a reproducible build gate. When an upstream release breaks, that is a finding, not noise: as of this release, a fresh `uvx mcpo` resolve fails at import because mcpo leaves its `mcp` dependency unbounded and the Python SDK v2 removed a symbol it uses. crosscheck classifies that as `adapter-broken` with the resolved version, and two escape hatches keep one broken upstream from blinding the rest of a run:

```sh
mcp-crosscheck --pin mcpo=0.0.20 --mcpo-with 'mcp<2' -- node ./dist/index.js
```

### The Codex adapter

Codex ships no introspection command — `codex mcp` covers list/get/add/remove, none of which show how Codex renders your schemas. The adapter reads through a provider intercept instead: it runs a real `codex exec` under a throwaway `CODEX_HOME` whose model provider points at a local stub server, and Codex's first Responses API request carries its converted `tools` array — Codex's exact rendered view of your server — before any model reply matters. The moment a tools-bearing request is captured, the Codex process is torn down.

No login is required, nothing reaches OpenAI, and zero tokens are spent. It is opt-in (`--adapters ...,codex`) because it boots the full Codex binary and reads a request shape Codex doesn't guarantee; a native `codex mcp tools --json` upstream would replace it.

## CLI reference

```
mcp-crosscheck [flags] -- <command> [args...]     stdio server under test
mcp-crosscheck --http <url> [flags]               running streamable-http server
```

| Flag | Meaning |
|:--|:--|
| `--adapters <a,b,c>` | Adapters to run. Default: `inspector,mcpo`. `codex` runs only when named. |
| `--canary '<tool>={json}'` | Safe tool to round-trip with exactly these args. |
| `--env <K=V>` | Environment variable for the spawned server (repeatable). |
| `--pin <name=version>` | Pin an adapter version instead of latest (repeatable). |
| `--mcpo-with <spec>` | Extra `uvx --with` dependency constraint for mcpo (repeatable). |
| `--artifacts <dir>` | Save raw captures: ground truth, `openapi.json`, the intercepted Codex request, `report.json`. |
| `--timeout <seconds>` | Per-stage timeout. Default: 120. |
| `--json` | Machine-readable report on stdout. |

## CI usage

Because latest floats, crosscheck belongs in an opt-in or scheduled lane, not your default reproducible gate:

```jsonc
// package.json
{
  "scripts": {
    "compat": "mcp-crosscheck --env MCP_LOG_LEVEL=error --canary 'echo_message={\"message\":\"probe\"}' -- node ./dist/index.js"
  }
}
```

A scheduled run surfaces converter regressions the day they land — including breakage entirely on the client's side. `--json` emits a stable report shape for scripted consumers, and the process exit code alone is enough for a pass/fail gate.

## Programmatic API

```ts
import { runCrosscheck } from 'mcp-crosscheck';

const report = await runCrosscheck({
  adapters: ['inspector', 'mcpo'],
  canary: { tool: 'echo_message', args: { message: 'probe' } },
  target: {
    kind: 'stdio',
    command: 'node',
    args: ['./dist/index.js'],
    env: { MCP_LOG_LEVEL: 'error' },
  },
});

console.log(report.pass, report.failCount, report.adapters);
```

The pieces are exported individually too: `captureGroundTruth`, `compareSurface`, `surfaceFromOpenApiDoc`, `surfaceFromCodexBody`, `renderHumanReport`.

## Roadmap

- Gemini CLI adapter — headless `gemini mcp list` reports connection status only today; a provider intercept like the Codex adapter's may expose the converted function declarations.
- Codex adapter support for streamable-http targets.
- Nested-schema comparison below root properties.

## Development

```sh
bun install
bun run devcheck   # format + lint (zero warnings), typecheck, build, tests, package sanity
bun test
```

CI is local-first: `devcheck` is the gate, run before every commit.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
