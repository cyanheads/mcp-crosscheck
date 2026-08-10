# Changelog

All notable changes to mcp-crosscheck are documented here.

## 0.0.1 — 2026-08-09

Initial release.

- Ground-truth capture via the official `@modelcontextprotocol/sdk` client: stdio and streamable-http targets, paginated `tools/list`, serverInfo.
- Invariant engine with two severity tiers. Fail: `tool-missing`, `empty-request-body`, `property-missing`, `property-untyped`, `description-lost`, `required-dropped`, `canary-failed`, `handshake-failure`, `adapter-broken`. Info: `constraint-dropped`, `anyof-ignored`.
- Adapters: MCP Inspector CLI (verbatim `tools/list` + `tools/call` canary), mcpo (generated `openapi.json` + live POST canary, `--mcpo-with` dependency-constraint escape), Codex CLI (opt-in provider-intercept capture — no login, no API traffic, zero tokens).
- Explicit `--canary '<tool>={json}'` round-trip, verified against ground truth before any adapter runs; never synthesized.
- `--pin <adapter>=<version>` pinning; resolved adapter versions reported on every run (latest floats by design).
- Human-readable report plus `--json`; `--artifacts <dir>` persists raw captures (ground truth, `openapi.json`, the intercepted Codex request, `report.json`).
- Hermetic execution: neutral scratch cwd for package runners, throwaway config homes, ephemeral ports, process-group teardown.
