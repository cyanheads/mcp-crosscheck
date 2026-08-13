# Changelog

All notable changes to mcp-crosscheck are documented here.

## 0.0.4 — 2026-08-13

Harness range.

- Added an opt-in Claude Code adapter that captures the installed client's rendered MCP declarations through an isolated loopback provider intercept, with exact installed-version pinning and a clean child environment. (#9)
- Added frozen adapter profiles for Inspector, mcpo, Codex, and Claude Code, including the client versions and schema behavior measured against the bundled fixture. (#11)
- Explicit-relative stdio command and argument paths now resolve before adapters enter their neutral scratch directory. (#18)
- Adapter failure excerpts now anchor on terminal error lines while preserving truthful omission markers around truncated output. (#19)
- Nested required-name loss, fully collapsed nested output objects, and explicit input/output type changes now produce scoped findings with regression coverage through nested objects and array items. (#20, #21, #22)

## 0.0.3 — 2026-08-09

Engine depth.

- Nested comparison: object fields and array elements are now diffed at every depth, not just root — each finding scoped by path (`tool.config.transport.timeoutMs`, `[]` for array elements). A depth limit plus a visited-ref set guarantee termination on a structurally recursive schema.
- Branch-declared fields: properties declared only inside an `anyOf`/`oneOf` branch are collected and compared on both sides, closing the class of bug where a tool with only branch-declared fields rendered as an empty request body and silently dropped every argument.
- `outputSchema` comparison: an advertised output schema is walked to the same depth under an `output:` path prefix, entirely at info tier — a lost or untyped output field misleads a model about what a call returns, but drops no argument.
- Inspector canary arguments now encode as a single `--tool-args-json` object instead of per-key `--tool-arg`, so integers, booleans, and empty strings reach the client verbatim; a pinned inspector before 2.0.0 (no `--tool-args-json`) reports the round-trip skipped rather than mangling an argument it can't spell as text.
- Fixed `required-dropped` to check branch-declared nested fields — a nested level whose own `required` names a field declared only inside an `anyOf`/`oneOf` branch no longer skips it.
- README rewrite: trimmed intro, captured fixture-server demo output in place of the roadmap section, and the new nested/branch/output-schema invariant rows folded in.

## 0.0.2 — 2026-08-09

Test bed.

- Bundled MCP fixture server (`tests/fixture-server/`): hand-written JSON Schema tools designed to break converters — a root `anyOf`, fields declared only inside branches, two levels of nesting, an `enum` with no `type`, a `const`, a `type` array, and a zero-argument tool. Runs standalone via `bun run fixture-server`, stdio or streamable-http.
- End-to-end suite (`tests/e2e.test.ts`) spawning the real CLI against the fixture server. Hermetic by default — no network, no binaries beyond bun; inspector/mcpo/codex lanes that resolve real clients at latest gate behind `CROSSCHECK_E2E_NETWORK=1` / `CROSSCHECK_E2E_CODEX=1`.
- Injectable process-execution seam (`Exec`, `nodeExec` — exported from the package root): every adapter resolves `ctx.exec ?? nodeExec`, so adapter failure-path classification (`adapter-broken`, `handshake-failure`) is unit-tested through fakes instead of a real upstream.
- `--help`'s `--artifacts` line now names `report.json` alongside the raw captures it already persisted.

## 0.0.1 — 2026-08-09

Initial release.

- Ground-truth capture via the official `@modelcontextprotocol/sdk` client: stdio and streamable-http targets, paginated `tools/list`, serverInfo.
- Invariant engine with two severity tiers. Fail: `tool-missing`, `empty-request-body`, `property-missing`, `property-untyped`, `description-lost`, `required-dropped`, `canary-failed`, `handshake-failure`, `adapter-broken`. Info: `constraint-dropped`, `anyof-ignored`.
- Adapters: MCP Inspector CLI (verbatim `tools/list` + `tools/call` canary), mcpo (generated `openapi.json` + live POST canary, `--mcpo-with` dependency-constraint escape), Codex CLI (opt-in provider-intercept capture — no login, no API traffic, zero tokens).
- Explicit `--canary '<tool>={json}'` round-trip, verified against ground truth before any adapter runs; never synthesized.
- `--pin <adapter>=<version>` pinning; resolved adapter versions reported on every run (latest floats by design).
- Human-readable report plus `--json`; `--artifacts <dir>` persists raw captures (ground truth, `openapi.json`, the intercepted Codex request, `report.json`).
- Hermetic execution: neutral scratch cwd for package runners, throwaway config homes, ephemeral ports, process-group teardown.
