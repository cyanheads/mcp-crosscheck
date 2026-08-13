# Contributing

## Local setup

mcp-crosscheck requires Node 22 or newer and uses Bun for development:

```sh
bun install
bun test
```

`bun test` is the fast hermetic lane. Before submitting a change, run the full local gate:

```sh
bun run devcheck
```

`devcheck` runs Biome with `--write`, then typechecking, the production build, the complete default test suite, the changelog/version check, and the built CLI shebang check. Review any formatting changes it applies.

## Opt-in client lanes

The default suite does not download or invoke external MCP clients. Run an opt-in lane when changing its adapter or capture profile:

```sh
CROSSCHECK_E2E_NETWORK=1 bun test tests/e2e.test.ts
CROSSCHECK_E2E_CODEX=1 bun test tests/e2e.test.ts
CROSSCHECK_E2E_CLAUDE_CODE=1 bun test tests/e2e.test.ts
```

- `CROSSCHECK_E2E_NETWORK` exercises Inspector and mcpo at their resolved releases; mcpo requires `uv` on `PATH`.
- `CROSSCHECK_E2E_CODEX` exercises the installed Codex CLI through its local provider intercept.
- `CROSSCHECK_E2E_CLAUDE_CODE` exercises the installed Claude Code client through its local base-URL intercept.

## Project constraints

Runtime code under `src/` must remain compatible with Node. Bun-specific APIs belong in tests and development tooling.

Adapters must capture a deterministic rendered surface without an account, tokens, model inference, or non-loopback provider traffic. Keep committed request fixtures limited to the parser-relevant declaration payload. Raw `--artifacts` output is local-sensitive and must not be committed or attached without review and redaction.

When a validated client capture changes, update the parser coverage and add a dated measurement to [docs/adapters.md](docs/adapters.md). The [README adapter table](README.md#adapters) remains the concise public overview; do not duplicate its measured behavior here.

Maintainers run versioning and releases. Contributions should include focused tests and documentation for the changed behavior without unrelated formatting or tooling changes.
