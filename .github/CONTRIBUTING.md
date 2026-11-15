# Contributing

Hi, and thanks for using `mcp-crosscheck`! If it reported drift that isn't there, missed drift that is, or broke on a client or server you run, an issue is the most useful thing you can send.

Issues are the contribution path here: bugs, feature requests, new adapters, and documentation gaps all land there, and code changes go through my workflows, so a precise issue with a reproduction is the fastest route to a fix.

- [Report a bug](https://github.com/cyanheads/mcp-crosscheck/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/cyanheads/mcp-crosscheck/issues/new?template=feature_request.yml)
- [Propose a client adapter](https://github.com/cyanheads/mcp-crosscheck/issues/new?template=adapter_request.yml)
- [Float an idea or ask a question](https://github.com/cyanheads/mcp-crosscheck/issues/new) — free-form, no template, no need to be sure it's a bug first

The forms are structured, and filling in the fields is what makes those actionable. Anything that fits none of them can just be a plain issue — a half-formed idea in your own words is fine.

## Before filing

A few things that save a round-trip:

1. **Confirm it's crosscheck, not the server or the client.** A finding compares what a client rendered with what the server advertised in `tools/list`. If `tools/list` itself shows the problem, it's in the server. If the client renders the tool the same way outside crosscheck, crosscheck reported it correctly. `--artifacts <dir>` saves the report, ground truth, and the raw client captures so you can compare both sides locally.
2. **Check you're on the latest release.** `npx mcp-crosscheck@latest --version` — fixes land on the current version, older ones aren't patched. Adapters run their client's newest release unless pinned, so note any `--pin` you passed.
3. **Search existing issues.** `gh issue list -R cyanheads/mcp-crosscheck --search "<keyword>" --state all`. Add to the matching thread instead of opening a duplicate.
4. **Redact anything sensitive.** Issues are public and permanent. Replace credentials, auth headers, tokens, and private endpoints with placeholders, and never attach raw `--artifacts` output ([what it contains](./SECURITY.md#handling-captures-and-credentials)).

## What makes an issue actionable

- The crosscheck version, the adapter and the client version the report resolved, the target transport (stdio or streamable HTTP), and the OS, Node, and Bun versions.
- The smallest command that reproduces it, ideally against a minimal server.
- The JSON report, or a redacted stdout/stderr excerpt, verbatim as it appeared.
- For features: the gap first — what crosscheck can't tell you today — then the flag, finding, or report shape you'd want.
- For adapters: how the client exposes its rendered tool surface locally. A client that needs an account, tokens, model inference, or non-loopback traffic to show it is out of scope.

## Reproducing from source

Node 22 or newer, with Bun for development:

```sh
bun install
bun run devcheck
```

`devcheck` is the full local gate: Biome with `--write`, typecheck, the production build, the default test suite, the changelog/version check, and the built CLI checks. The default suite is hermetic and never invokes a real client. To run one, set its opt-in lane:

```sh
CROSSCHECK_E2E_NETWORK=1 bun test tests/e2e/inspector.test.ts tests/e2e/mcpo.test.ts
CROSSCHECK_E2E_CODEX=1 bun test tests/e2e/codex.test.ts
CROSSCHECK_E2E_CLAUDE_CODE=1 bun test tests/e2e/claude-code.test.ts
```

- `CROSSCHECK_E2E_NETWORK` exercises Inspector and mcpo at their resolved releases; mcpo requires `uv` on `PATH`.
- `CROSSCHECK_E2E_CODEX` exercises Codex CLI at its resolved release (`npx -y @openai/codex`) through its local provider intercept.
- `CROSSCHECK_E2E_CLAUDE_CODE` exercises the installed Claude Code client through its local base-URL intercept.

## For agents

Use one of the forms and do the triage first. The free-form path is for humans thinking out loud, not for skipping the checklist — an unverified report costs more to read than it saves to file.

The full workflow is in [`skills/report-issue-local/SKILL.md`](../skills/report-issue-local/SKILL.md): dedup search, `gh` invocations with bodies that match the forms, title scopes, and labels. Read it before filing on a user's behalf.

## Security

Don't open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md) for private disclosure.
