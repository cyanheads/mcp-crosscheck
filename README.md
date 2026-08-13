<div align="center">
  <h1>mcp-crosscheck</h1>
  <p><b>Test the tool schema your MCP clients actually see.</b></p>
  <p>Run real clients against your server and diff their rendered tool surface against <code>tools/list</code>. No LLM calls. No API keys.</p>
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

# verify one safe tool call with exact arguments
npx mcp-crosscheck --canary 'echo_message={"message":"probe"}' -- node ./dist/index.js

# include the opt-in Codex adapter
npx mcp-crosscheck --adapters inspector,mcpo,codex -- node ./dist/index.js
```

Requires Node 22 or newer. The mcpo adapter also requires [`uv`](https://docs.astral.sh/uv/) on `PATH`.

Exit codes: `0` pass, `1` findings or runtime failure, `2` usage error.

## What it catches

| Tier | Findings |
|:--|:--|
| **fail** | Missing tools or input properties; empty request bodies; properties rendered without type information or with a changed explicit type; lost descriptions or `required` markers; adapter launch, MCP handshake, or canary failures |
| **info** | Dropped constraints such as `enum`, `minimum`, and `pattern`; ignored root `anyOf`/`oneOf`; missing, untyped, or explicitly retyped `outputSchema` fields |

Input checks recurse through nested objects and array items. When an adapter exposes a result model, output-schema drift stays informational because it can mislead a model about a result but does not drop an argument.

The optional canary uses one tool and the exact arguments you provide. Crosscheck verifies the call against your server first, then repeats it through adapters that support calls. It never invents a tool call.

## Adapters

| Adapter | Default | Targets | What is captured |
|:--|:--:|:--|:--|
| [MCP Inspector](https://github.com/modelcontextprotocol/inspector) | yes | stdio, HTTP | Verbatim `tools/list` plus an optional canary call |
| [mcpo](https://github.com/open-webui/mcpo) | yes | stdio, HTTP | Generated OpenAPI document plus an optional POST canary |
| [Codex CLI](https://github.com/openai/codex) | no | stdio | Converted function schemas from a local provider intercept; capture-only |

The Codex adapter runs under a throwaway `CODEX_HOME` pointed at a loopback stub. It stops as soon as the tools-bearing request is captured, without logging in or contacting OpenAI.

Adapters resolve their latest release by default. This makes crosscheck useful as a scheduled compatibility canary: schema drift appears in the comparison, while a client that no longer launches is reported as `adapter-broken` with its resolved version. Pin versions when you need a fixed comparison:

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
| `--env <K=V>` | Add an environment variable to the stdio server. Repeatable. |
| `--pin <name=version>` | Pin an adapter version. Repeatable. |
| `--mcpo-with <spec>` | Add an `uvx --with` constraint for mcpo. Repeatable. |
| `--artifacts <dir>` | Save ground truth, raw adapter captures, and `report.json`. |
| `--timeout <seconds>` | Set the per-stage timeout. Default: `120`. |
| `--json` | Write the report as JSON. Progress stays on stderr. |

## Programmatic API

```ts
import { runCrosscheck } from 'mcp-crosscheck';

const report = await runCrosscheck({
  adapters: ['inspector', 'mcpo'],
  target: { kind: 'stdio', command: 'node', args: ['./dist/index.js'], env: {} },
});

console.log(report.pass, report.failCount);
```

The package also exports the ground-truth capture, schema normalizers, comparison engine, adapter parsers, and report renderers.

## Development

```sh
bun install
bun run devcheck
```

The default suite is hermetic. Set `CROSSCHECK_E2E_NETWORK=1` to exercise Inspector and mcpo at their current releases, or `CROSSCHECK_E2E_CODEX=1` to run the Codex capture lane.

## License

Apache 2.0. See [LICENSE](./LICENSE).
