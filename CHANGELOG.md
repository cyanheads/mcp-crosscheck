# Changelog

All notable changes to mcp-crosscheck are documented here.

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
