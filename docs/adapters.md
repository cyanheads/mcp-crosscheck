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
| Executable | `npx` on `PATH` (it ships with npm, part of Node.js), launched without a shell. A missing `npx` is `adapter-broken` naming what provides it; any other spawn failure, such as an argument list the OS refuses (`E2BIG`), is `adapter-broken` with the spawn error |
| Canary | Optional `tools/call` with exact user-supplied arguments |
| HTTP headers | Repeats Inspector's `--header 'Name: value'` for each configured target header |
| Version | An unpinned run asks npm for the latest version once (Inspector has no safe `--version` invocation) and spawns `@modelcontextprotocol/inspector@<that version>` for `tools/list` and the canary alike, so a globally installed copy of another release never runs in its place. If the lookup fails, both spawn `@latest` and `resolvedVersion` is null. A pin is spawned as `@<pin>` |
| Target launch | Inspector receives only the launcher command line, with no `-e` flags and none of the target's own arguments; the launcher starts the target with ground truth's command, arguments, environment, and working directory. Inspector itself runs from the scratch directory with the caller's environment |
| Failures | A timeout is `handshake-failure`; an `npx` that never started is `adapter-broken`; a non-zero exit is `adapter-broken` when npm could not install the client and `handshake-failure` otherwise; an exit-0 output that does not parse is `capture-failure`, naming its byte count or the capture limit and never its text |
| Output | Preserves an advertised `outputSchema` from `tools/list` |

Inspector receives HTTP header values in its process arguments. They may be visible to local process inspection even though crosscheck removes exact values from its own diagnostics and reports.

### Dated measurements

| Date | Client | Evidence | Reproduction constraint | Measured surface |
|:--|:--|:--|:--|:--|
| 2026-08-09 | MCP Inspector 2.1.0 | Pinned network lane in `tests/e2e/inspector.test.ts`; no raw Inspector fixture | Pin `inspector=2.1.0` | `tools/list` passed through the normalizer with zero findings against the fixture. On 2.x the canary uses `--tool-args-json`; a pinned pre-2.0.0 client falls back to string-only `--tool-arg` and skips canaries containing a non-string or empty-string value. |
| 2026-11-15 | MCP Inspector 2.1.0, 2.8.0, 0.16.5, and 2.15.0 (unpinned latest) | Launch-parity cases in the network lane of `tests/e2e/inspector.test.ts`; no raw Inspector fixture | `--env`, a bare relative target path, target arguments `--flag x -e y`, string-only canary (0.16.5 sends it with `--tool-arg`) | Each run completed `ok` with zero findings and a passing canary. The fixture recorded four starts per run (ground truth, its canary, Inspector's `tools/list` and canary), each with ground truth's environment names, `HOME`, working directory, and argument tail; a variable exported in the shell but not passed with `--env` reached none. |

## mcpo

### Profile

| Setting | Behavior |
|:--|:--|
| Selection | Default |
| Targets | stdio and streamable HTTP |
| Capture | Starts the OpenAPI proxy and takes the first `openapi.json` response as the surface; mcpo registers every tool route before uvicorn accepts a connection. A non-2xx answer is `handshake-failure` naming the status; a body that is not an OpenAPI document is `capture-failure` with its byte count |
| Executable | `uvx` on `PATH` (it ships with uv). A missing `uvx` is `adapter-broken` naming uv; any other spawn failure is `adapter-broken` with the spawn error |
| Canary | Optional POST with exact user-supplied arguments |
| HTTP headers | Passes one JSON header map through mcpo's `--header` before its target separator |
| Version | An unpinned run reads the latest release from PyPI once and spawns `mcpo@<that version>`, so a `uv tool install`-ed copy of another release never runs in its place; a failed lookup spawns `mcpo@latest` and reports a null `resolvedVersion`. A pin is spawned as `mcpo@<pin>` |
| Dependency constraints | Every run, pinned or not, adds `--with mcp<2` (Python `mcp` 2.x removed `streamablehttp_client`, which mcpo 0.0.20 imports) and `--with fastapi<0.145` (FastAPI 0.145.0 removed `FastAPI(**extra)`, and mcpo 0.0.20 passes `ssl_certfile`). A `--mcpo-with` entry whose PEP 503-normalized name is `mcp` or `fastapi` replaces that default; any other entry is added alongside. The progress log names the defaults in force |
| Target launch | mcpo receives the launcher command line after its `--` separator and hands it mcpo's whole environment; the launcher replaces that with ground truth's. mcpo itself runs from the scratch directory with the caller's environment |
| Output | Parses a generated response model when the OpenAPI document contains one |

The mcpo child argument contains the configured values. Its raw `mcpo.openapi.json` artifact is server-controlled and remains local-sensitive.

### Dated measurements

| Date | Client | Evidence | Reproduction constraint | Measured surface |
|:--|:--|:--|:--|:--|
| 2026-08-09 | mcpo 0.0.20 | `tests/fixtures/mcpo-openapi.json`, `tests/fixtures/ground-truth.json`, and `src/adapters/mcpo.test.ts` | Run with `--mcpo-with 'mcp<2'`; this is an environment constraint, not a property of mcpo 0.0.20 | Form-model `$ref`s preserved the tested tool descriptions, property types, required fields, nested requests, and generated response models. The comparison recorded dropped `enum` and numeric bounds. The fixture has no root input union or advertised `outputSchema`, so it does not measure root-input-union handling or end-to-end output-schema fidelity. |
| 2026-09-26 | mcpo 0.0.20 | Local `--artifacts` capture against a stdio scratch server; no new frozen fixture | Run with `--mcpo-with 'mcp<2'` | A root input schema composed only of `allOf` members generated `requestBody: null`, recorded as `empty-request-body`. A root-recursive schema whose array items use a whole-document `$ref: "#"` stopped mcpo at startup with `KeyError: '#'`, recorded as `adapter-broken`. A map property with `additionalProperties: {type: 'string'}` rendered as `additionalProperties: true`, recorded as `constraint-altered`. A property written as a one-member `allOf` around an `enum` `$ref` rendered with its description but no type or `enum`, recorded as `property-untyped` and `constraint-dropped`. |
| 2026-11-15 | mcpo 0.0.20 (unpinned latest) | Network lane in `tests/e2e/mcpo.test.ts` | No `--mcpo-with`; the default constraints resolved mcp 1.30.0 and FastAPI 0.144.0 on Python 3.14 | The default run completed `ok` with six tools and a passing canary. A parity run recorded three target starts (ground truth, its canary, mcpo's one session), each matching ground truth's launch. |

## Codex CLI

### Profile

| Setting | Behavior |
|:--|:--|
| Selection | Opt-in |
| Targets | stdio and streamable HTTP |
| Capture | Runs `codex exec` under a throwaway `HOME`/`CODEX_HOME` whose loopback provider (`wire_api = "responses"`) captures the first request carrying a non-empty `tools` array. An `mcp__*` namespace entry or `mcp__target__` entry that does not parse is `capture-failure`, named in the detail. A capture with no MCP tools is an empty surface: `ok` against a server that lists none, `handshake-failure` when ground truth lists tools |
| Executable | `npx` on `PATH`, launched without a shell. A missing `npx` is `adapter-broken` naming what provides it; any other spawn failure is `adapter-broken` with the spawn error |
| Canary | None; capture-only |
| Version | The pin; otherwise `npm view @openai/codex version`; otherwise what `npx -y @openai/codex@latest --version` prints. Every `npx` call in a run names `@openai/codex@<that version>`, and one `--version` prime runs in the caller's environment every run, pinned or not, so the launch finds that release in the npm cache |
| Environment | The launch gets throwaway `CODEX_HOME` and `HOME`, `NO_PROXY=*`, `PATH`, the generated header variables (HTTP targets only), and `npm_config_cache` from `npm config get cache` run in the caller's environment. A prime that cannot start, or a failed or empty `npm config get cache`, is `adapter-broken` |
| Target launch | The `[mcp_servers.target]` table carries only the launcher command line, with no `env` table; the launcher starts the target with ground truth's command, arguments, environment, and working directory |
| HTTP target | URL-only targets use `url`. Configured headers use generated `MCP_CROSSCHECK_TARGET_HEADER_<n>` names in `env_http_headers`; values exist only in the isolated child environment |
| Tool names | Modeled by `codexToolRenames`, a port of `normalize_tools_for_model_with_prefix` (rust-v0.169.0): each Unicode scalar outside `[A-Za-z0-9_]` becomes `_`; every member of a group that sanitizes alike, and any name that does not fit 128 bytes beside `mcp__target__`, gets `_<12 hex of sha1(raw identity)>`, retried with an attempt counter until unique, in UTF-8 byte order of raw identity. A renamed tool is compared under its advertised name and reported as `tool-renamed` |
| Output | Captures input `parameters` only and exposes no rendered output surface |

The Codex launch inherits no ambient auth, provider-selection, proxy, or user-config variables and reads no user `.npmrc`; the prime, which runs with the caller's npm configuration, is the run's one install. Crosscheck does not place header values in TOML, Codex argv, reports, or the captured model request; raw captures remain local-sensitive.

### Dated measurements

| Date | Client | Evidence | Reproduction constraint | Measured surface |
|:--|:--|:--|:--|:--|
| 2026-08-09 | Codex CLI 0.147.0 | `tests/fixtures/codex-request.json`, `tests/fixtures/ground-truth.json`, and `src/adapters/codex.test.ts` | Throwaway `CODEX_HOME` and loopback Responses provider | The `mcp__target` namespace preserved the tested names, descriptions, types, required fields, and `enum`. The comparison recorded dropped numeric bounds. The capture has no rendered output-schema surface. |
| 2026-08-13 | Codex CLI 0.147.0-alpha.6.5 | Protected HTTP lane in `tests/e2e/codex.test.ts`, the frozen request parser fixture, and adapter config tests | Clean child environment, throwaway `HOME`/`CODEX_HOME`, environment-backed target header, and loopback Responses provider | The protected streamable HTTP fixture produced six MCP declarations. Comparison recorded six info-only constraint drops, matching the stdio fixture shape. The capture has no rendered output-schema surface. |
| 2026-11-15 | Codex CLI 0.169.0 | Opt-in lane in `tests/e2e/codex.test.ts` | `CROSSCHECK_E2E_CODEX=1`; fixture server, `--env` names `MY.VAR`, `A B`, and `Q"X`, an empty server (`MCP_FIXTURE_TOOLS='[]'`), and the protected HTTP fixture | The fixture, launch-parity, empty-server, and protected HTTP cases passed on two runs; the target started with ground truth's environment names and argument tail. A fourteen-name server (sanitize collisions, the 128-byte bound, an attempt-counter retry, code-point order) produced eleven `tool-renamed` findings that `codexToolRenames` predicts and no `tool-missing`. |

## Claude Code

### Profile

| Setting | Behavior |
|:--|:--|
| Selection | Opt-in |
| Targets | stdio only |
| Capture | Runs the installed `claude` executable with isolated `HOME` and `CLAUDE_CONFIG_DIR`, `--bare`, one strict MCP config, dummy auth, and a loopback base URL; captures the first request carrying a non-empty `tools` array. An `mcp__target__` entry that does not parse is `capture-failure`, named in the detail. A capture with no MCP tools is an empty surface: `ok` against a server that lists none, `handshake-failure` when ground truth lists tools |
| Executable | `claude` on `PATH`, launched without a shell. On Windows that means the native installer's `claude.exe`: an npm global install provides only a `claude.cmd` shim, and a missing executable is `adapter-broken` with that explanation. A launch that never started is `adapter-broken` naming the spawn error (`claude could not start — …`) |
| Canary | None; capture-only |
| Version | Resolves `claude --version`. A `claude-code` pin must exactly match the installed version; a mismatch is `adapter-broken` and the client is not launched |
| Environment | The launch gets the isolated `HOME` and `CLAUDE_CONFIG_DIR`, a dummy `ANTHROPIC_API_KEY`, the loopback `ANTHROPIC_BASE_URL`, `NO_PROXY=*`, and `PATH`, and nothing else from the caller |
| Target launch | `mcpServers.target` carries only the launcher command line, with no `env` block; the launcher starts the target with ground truth's command, arguments, environment, and working directory |
| Tool names | Modeled by `claudeCodeToolRenames`: each UTF-16 unit outside `[a-zA-Z0-9_-]` becomes `_`, and a name beginning `claude.ai ` also has its underscore runs collapsed and trimmed. A name longer than 128 units once prefixed with `mcp__target__` is dropped, and of names that render alike the first in `tools/list` order wins and the rest are dropped; a dropped tool reports as `tool-missing` with the reason. The order of those two drops is inferred from the minified client. A renamed tool is compared under its advertised name and reported as `tool-renamed` |
| Output | Parses exact `mcp__target__<tool>` entries from `description` and `input_schema`; native tools are ignored and no output surface is exposed |

Full `claude-code.request.json` artifacts can contain prompt, session, and client metadata. They are written only when an artifacts directory is selected and should remain local and sensitive.

### Dated measurements

| Date | Client | Evidence | Reproduction constraint | Measured surface |
|:--|:--|:--|:--|:--|
| 2026-08-13 | Claude Code 2.1.231 | `tests/fixtures/claude-code-request.json` and `src/adapters/claude-code.test.ts` | Isolated `HOME`/`CLAUDE_CONFIG_DIR`, `--bare --strict-mcp-config --mcp-config … --print ping`, and loopback `POST /v1/messages?beta=true` | Flat MCP entries carried `description` and `input_schema` with no output surface. Against the bundled fixture, root `anyOf` branches were flattened into properties, and the descriptions of the two root-union tools, `union_modes` and `branch_only_fields`, were replaced by an `Input constraint: Provide parameters for at least one of: …` summary (recorded as two `rewritten` description changes). The other exercised descriptions, types, required names, nested schemas, and constraints survived. |
| 2026-09-26 | Claude Code 2.1.283 | Opt-in lane in `tests/e2e/claude-code.test.ts` against the installed client, plus a local capture of one long-description tool; no new frozen fixture | Same as 2.1.231 | The bundled fixture rendered as on 2.1.231: all six tools, root `anyOf` flattened, and the two root-union descriptions replaced. A 4,712-character tool description was cut to its first 2,048 characters with `… [truncated]` appended, recorded as a `truncated` description change; a 4,716-character property description survived whole. |
| 2026-11-15 | Claude Code 2.1.325 | Opt-in lane in `tests/e2e/claude-code.test.ts` against the installed client | `CROSSCHECK_E2E_CLAUDE_CODE=1`; fixture server, `--env` launch parity, an empty server (`MCP_FIXTURE_TOOLS='[]'`) | The fixture, launch-parity, and empty-server cases passed; the target started with ground truth's environment names and argument tail. An eight-name server produced three `tool-renamed` findings and two `tool-missing` drops (a collision loser and a name over 128 units once prefixed), each as `claudeCodeToolRenames` predicts. |

## Pending captures

Gemini CLI 0.42.0 reached a loopback model endpoint but emitted no declaration for the configured fixture. Its rendered MCP surface remains unmeasured until a request containing those declarations is captured and covered by a parser test.

## Updating measurements

Every fixture re-capture or new frozen adapter fixture adds a dated row naming the client version, fixture, parser test, and reproduction constraint. Committed request fixtures keep only the parser-relevant payload. Complete raw requests belong only in an explicitly selected local artifacts directory because they may contain volatile or sensitive client metadata.

Target headers do not change that boundary. Crosscheck removes exact configured values from its statuses, findings, human/JSON reports, and persisted `report.json`. Raw ground-truth and adapter captures can contain arbitrary server echoes or transformed values, so the entire artifacts directory remains local-sensitive.
