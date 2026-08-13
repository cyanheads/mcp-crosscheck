# Adapter profiles and measurements

An adapter profile describes behavior that is stable in the harness source. A dated measurement records what one client version rendered in a frozen fixture. A successful connection or handshake proves only that the adapter ran; a measured surface requires a captured request or document plus a parser test.

Measurements are historical evidence, not claims about newer upstream releases.

## MCP Inspector

### Profile

| Setting | Behavior |
|:--|:--|
| Selection | Default |
| Targets | stdio and streamable HTTP |
| Capture | Runs `tools/list` through the Inspector CLI and normalizes the returned MCP schemas |
| Canary | Optional `tools/call` with exact user-supplied arguments |
| Version | A pin is passed to `npx`; unpinned runs resolve the package version from npm because Inspector has no safe `--version` invocation |
| Output | Preserves an advertised `outputSchema` from `tools/list` |

### Dated measurements

| Date | Client | Evidence | Reproduction constraint | Measured surface |
|:--|:--|:--|:--|:--|
| 2026-08-09 | MCP Inspector 2.1.0 | Pinned network lane in `tests/e2e.test.ts`; no raw Inspector fixture | Pin `inspector=2.1.0` | `tools/list` passed through the normalizer with zero findings against the fixture. On 2.x the canary uses `--tool-args-json`; a pinned pre-2.0.0 client falls back to string-only `--tool-arg` and skips canaries containing a non-string or empty-string value. |

## mcpo

### Profile

| Setting | Behavior |
|:--|:--|
| Selection | Default |
| Targets | stdio and streamable HTTP |
| Capture | Starts the OpenAPI proxy and parses `openapi.json` after readiness |
| Canary | Optional POST with exact user-supplied arguments |
| Version | A pin is passed to `uvx`; unpinned runs resolve the exercised release from the client or PyPI |
| Output | Parses a generated response model when the OpenAPI document contains one |

### Dated measurements

| Date | Client | Evidence | Reproduction constraint | Measured surface |
|:--|:--|:--|:--|:--|
| 2026-08-09 | mcpo 0.0.20 | `tests/fixtures/mcpo-openapi.json`, `tests/fixtures/ground-truth.json`, and `src/adapters/adapters.test.ts` | Run with `--mcpo-with 'mcp<2'`; this is an environment constraint, not a property of mcpo 0.0.20 | Form-model `$ref`s preserved the tested tool descriptions, property types, required fields, nested requests, and generated response models. The comparison recorded dropped `enum` and numeric bounds. The fixture has no root input union or advertised `outputSchema`, so it does not measure root-input-union handling or end-to-end output-schema fidelity. |

## Codex CLI

### Profile

| Setting | Behavior |
|:--|:--|
| Selection | Opt-in |
| Targets | stdio only |
| Capture | Runs `codex exec` under a throwaway `CODEX_HOME`; a loopback provider with `wire_api = "responses"` captures the first tools-bearing request |
| Canary | None; capture-only |
| Version | A pin selects the `@openai/codex` package passed to `npx`; unpinned runs resolve the exercised package version |
| Output | Captures input `parameters` only and exposes no rendered output surface |

### Dated measurements

| Date | Client | Evidence | Reproduction constraint | Measured surface |
|:--|:--|:--|:--|:--|
| 2026-08-09 | Codex CLI 0.147.0 | `tests/fixtures/codex-request.json`, `tests/fixtures/ground-truth.json`, and `src/adapters/adapters.test.ts` | Throwaway `CODEX_HOME` and loopback Responses provider | The `mcp__target` namespace preserved the tested names, descriptions, types, required fields, and `enum`. The comparison recorded dropped numeric bounds. The capture has no rendered output-schema surface. |

## Claude Code

### Profile

| Setting | Behavior |
|:--|:--|
| Selection | Opt-in |
| Targets | stdio only |
| Capture | Runs the installed `claude` executable with isolated `HOME` and `CLAUDE_CONFIG_DIR`, `--bare`, one strict MCP config, dummy auth, and a loopback base URL; captures the first tools-bearing request |
| Canary | None; capture-only |
| Version | Resolves `claude --version`. A `claude-code` pin must exactly match the installed version; a mismatch is `adapter-broken` and the client is not launched |
| Output | Parses exact `mcp__target__<tool>` entries from `description` and `input_schema`; native tools are ignored and no output surface is exposed |

Full `claude-code.request.json` artifacts can contain prompt, session, and client metadata. They are written only when an artifacts directory is selected and should remain local and sensitive.

### Dated measurements

| Date | Client | Evidence | Reproduction constraint | Measured surface |
|:--|:--|:--|:--|:--|
| 2026-08-13 | Claude Code 2.1.231 | `tests/fixtures/claude-code-request.json` and `src/adapters/adapters.test.ts` | Isolated `HOME`/`CLAUDE_CONFIG_DIR`, `--bare --strict-mcp-config --mcp-config … --print ping`, and loopback `POST /v1/messages?beta=true` | Flat MCP entries carried `description` and `input_schema` with no output surface. Against the bundled fixture, root `anyOf` branches were flattened into properties. The other exercised descriptions, types, required names, nested schemas, and constraints survived. |

## Pending captures

Gemini CLI 0.42.0 reached a loopback model endpoint but emitted no declaration for the configured fixture. Its rendered MCP surface remains unmeasured until a request containing those declarations is captured and covered by a parser test.

## Updating measurements

Every fixture re-capture or new frozen adapter fixture adds a dated row naming the client version, fixture, parser test, and reproduction constraint. Committed request fixtures keep only the parser-relevant payload. Complete raw requests belong only in an explicitly selected local artifacts directory because they may contain volatile or sensitive client metadata.
