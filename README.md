<div align="center">
  <h1>mcp-crosscheck</h1>
  <p><b>Run real MCP clients against your server and diff what they render against what you advertise.</b></p>
  <p>Deterministic — no LLM calls, no API keys.</p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.0.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![npm](https://img.shields.io/npm/v/mcp-crosscheck?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/mcp-crosscheck) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933.svg?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-%5E1.30.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-%5E7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)

</div>

---

Your server advertises tools over `tools/list`. Every client re-renders that JSON Schema into its own model (an OpenAPI request body, an OpenAI function schema) and each converter silently drops what it doesn't handle: union parameters render with no type, fields declared inside `anyOf` branches collapse into an empty request body, `enum` and numeric bounds vanish. Your test suite validates what you advertise. Nothing validates what clients actually render.

`mcp-crosscheck` closes that gap. It captures ground truth with the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) client, launches real clients at their latest released versions against the same server, and diffs each rendered surface against ground truth — catching both the schema idiom a converter mangles and the converter release that breaks rendering with no change on your side.

## Quick start

```sh
# stdio server — the canary names a safe tool to round-trip, with exact args
npx mcp-crosscheck --canary 'echo_message={"message":"probe"}' -- node ./dist/index.js

# already-running streamable-http server
npx mcp-crosscheck --http https://example.com/mcp

# opt in to the Codex adapter
npx mcp-crosscheck --adapters inspector,mcpo,codex -- node ./dist/index.js
```

Runs on Node ≥ 22; `bunx` works identically. The mcpo adapter needs [`uv`](https://docs.astral.sh/uv/) on PATH. Exit codes: `0` pass · `1` failures · `2` usage error.

Real output, against this repo's bundled fixture server — six tools whose schemas are built to break converters — with mcpo pinned past its import-broken latest:

```
mcp-crosscheck v0.0.2 → crosscheck-fixture-server@1.0.0 (6 tools advertised)

inspector (v2.1.0, 2.9s) PASS
  rendered 6/6 tools
  canary: round-trip ok
  no divergence from ground truth

mcpo (v0.0.20, 1.6s) 3 FAIL
  rendered 6/6 tools
  canary: round-trip ok
  FAIL [empty-request-body] branch_only_fields ground truth advertises 2 input properties, declared inside anyOf/oneOf branches, but the client rendered an empty request body — every argument would be dropped
  FAIL [property-untyped] typed_edges.kind property rendered with no type information (ground truth: enum<string>)
  FAIL [property-untyped] typed_edges.version property rendered with no type information (ground truth: const<number>)
  info [constraint-dropped] echo_message.mode constraint keyword dropped: enum
  info [constraint-dropped] nested_config.config.transport.timeoutMs constraint keyword dropped: minimum
  info [anyof-ignored] union_modes root anyOf/oneOf union is not represented in the rendered surface — the client cannot enforce which branch applies (fields declared inside the branches are compared as properties)
  ...

FAIL — 3 failure(s), 9 info note(s) across 2 adapter(s)
```

One converter, one run: arguments that would silently vanish, properties stripped of their types, and constraint erosion down to depth three — none of it visible from the server's own tests.

## What it checks

Two severity tiers. `fail` is divergence that breaks agents in the wild; `info` is recorded degradation that never fails a run.

| Tier | Invariants |
|:--|:--|
| **fail** | tool missing from the rendered surface · property missing, including fields declared only inside an `anyOf`/`oneOf` branch · property rendered with no type information · tool or property description lost · `required` dropped at the level that declares it · empty request body for a tool that advertises properties, or a nested object rendered with none of its fields · canary round-trip fails through the adapter · MCP handshake failure · `adapter-broken` (the client itself failed to launch, reported with its resolved version) |
| **info** | dropped constraint keywords (`minimum`, `maximum`, `pattern`, `format`, `enum`, `minLength`, `maxLength`, `additionalProperties`, …) · root `anyOf`/`oneOf` union a client ignores rather than enforces · a field of an advertised `outputSchema` the client's rendered result model drops or renders untyped |

The property rules run at every level, not just root: nested objects and array elements are compared the same way, each finding scoped by path — `connect.config.transport.timeoutMs`, with `[]` for elements. Fields declared only inside `anyOf`/`oneOf` branches are collected on both sides before the diff, so a converter that reads `properties` alone is caught dropping them instead of passing with an empty request body. An advertised `outputSchema` is walked to the same depth under an `output:` prefix, info-tier throughout: a lost output field misleads a model about what a call returns, but drops no argument.

The canary is never synthesized. You name one safe tool and its exact arguments, crosscheck verifies the call against your own server first, then round-trips it through each adapter. Arguments reach each client verbatim, integers and empty strings included; where a client's encoding cannot express them (a `--pin`ned MCP Inspector before 2.0.0), the round-trip reports skipped, not failed.

## Adapters

| Adapter | Runs | Rendered surface | Notes |
|:--|:--|:--|:--|
| [MCP Inspector](https://github.com/modelcontextprotocol/inspector) | `npx @modelcontextprotocol/inspector --cli` | verbatim `tools/list` | The protocol-handshake baseline. stdio and streamable-http. |
| [mcpo](https://github.com/open-webui/mcpo) | `uvx mcpo` | generated `openapi.json` + live POST canary | open-webui's MCP → OpenAPI proxy. stdio and streamable-http. |
| [Codex CLI](https://github.com/openai/codex) | `npx @openai/codex exec` under a throwaway `CODEX_HOME` | intercepted Responses API request body | **Opt-in.** stdio targets. Capture-only (no canary). |

**Latest floats by design.** Adapters resolve `@latest` at run time: a crosscheck run is a canary, not a reproducible build gate, so a broken upstream release is a finding (`adapter-broken`, with the resolved version), not noise. Two escape hatches keep one broken upstream from blinding a run:

```sh
mcp-crosscheck --pin mcpo=0.0.20 --mcpo-with 'mcp<2' -- node ./dist/index.js
```

### The Codex adapter

Codex ships no schema introspection, so the adapter reads through a provider intercept: a real `codex exec` runs under a throwaway `CODEX_HOME` whose model provider points at a local stub, and Codex's first Responses API request carries its converted `tools` array — its exact rendered view of your server. The process is torn down the moment that request is captured. No login, nothing reaches OpenAI, zero tokens spent. It stays opt-in because it boots the full Codex binary and reads a request shape Codex doesn't guarantee.

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

Latest floats, so crosscheck belongs in an opt-in or scheduled lane, not your default reproducible gate:

```jsonc
// package.json
{
  "scripts": {
    "compat": "mcp-crosscheck --canary 'echo_message={\"message\":\"probe\"}' -- node ./dist/index.js"
  }
}
```

A scheduled run surfaces converter regressions the day they land, including breakage entirely on the client's side. `--json` emits a stable report shape; the exit code alone is enough for a pass/fail gate.

## Programmatic API

```ts
import { runCrosscheck } from 'mcp-crosscheck';

const report = await runCrosscheck({
  adapters: ['inspector', 'mcpo'],
  canary: { tool: 'echo_message', args: { message: 'probe' } },
  target: { kind: 'stdio', command: 'node', args: ['./dist/index.js'], env: {} },
});

console.log(report.pass, report.failCount, report.adapters);
```

The pieces are exported individually too: `captureGroundTruth`, `compareSurface`, `surfaceFromOpenApiDoc`, `surfaceFromCodexBody`, `renderHumanReport`.

## Development

```sh
bun install
bun run devcheck   # format + lint (zero warnings), typecheck, build, tests, package sanity
```

Tests run hermetically against a bundled fixture server (`tests/fixture-server/`) whose hand-written schemas are picked to break converters: a root `anyOf`, branch-only fields, two levels of nesting, a nested `outputSchema`, an `enum` with no `type`, a `const`, a `type` array, a zero-argument tool. Lanes that resolve real clients at latest are opt-in — `CROSSCHECK_E2E_NETWORK=1` for inspector and mcpo (mcpo also needs `uv`), `CROSSCHECK_E2E_CODEX=1` for Codex (boots the full binary, minutes not seconds). A skipped lane prints what enables it.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
