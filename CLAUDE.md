# mcp-crosscheck

A CLI and library that runs real MCP clients against a target server and diffs each client's **rendered** tool surface against the server's own `tools/list`. Deterministic: no model inference, no non-loopback provider traffic, no API keys.

Published to npm as `mcp-crosscheck` (unscoped — never add a scope on any surface). Apache-2.0, public repo, Node ≥22, Bun for development.

## Stack and gates

TypeScript strict ESM, Bun for dev, Biome for lint/format, `bun test` for tests, `tsc` for the build.

```sh
bun install
bun run devcheck   # the gate — run before declaring any work complete
```

`devcheck` (`scripts/devcheck.ts`) runs Biome with `--write --error-on-warnings`, typecheck, build, the full test suite, the CHANGELOG-carries-current-version check, and the `dist/cli.js` shebang check. Warnings are failures. Run it raw — it auto-fixes formatting, so filtering its output hides what it changed.

Runtime code under `src/` must stay Node-compatible; Bun-only APIs belong in tests and `scripts/`.

## Architecture

| Path | Role |
|:--|:--|
| `src/cli.ts` | Flag parsing, stderr progress, stdout report. Exit codes: 0 pass, 1 findings/runtime failure, 2 usage error |
| `src/run.ts` | Orchestration: ground truth → canary preflight → each adapter → baseline reconciliation → report |
| `src/ground-truth.ts` | The server's own surface, captured with the official MCP TypeScript SDK client |
| `src/schema.ts` | JSON Schema → the comparable `RenderedTool` / `RenderedProperty` model. Both sides normalize through here |
| `src/invariants.ts` | Pure comparison. `fail` = breaks agents in the wild; `info` = recorded degradation |
| `src/baseline.ts` | Strict v1 baseline parse, reconcile, atomic write |
| `src/adapters/` | One file per client. `inspector` and `mcpo` run by default; `codex` and `claude-code` are opt-in and capture-only |
| `src/util/exec.ts` | The `Exec` seam every adapter spawns through — the reason failure paths are testable without real clients |
| `tests/fixture-server/` | Bundled adversarial MCP server (stdio + streamable HTTP) the E2E suite runs against |

Ground truth and every rendered surface flow through the same normalizer. A diff only means something if both sides flatten identically — change `schema.ts` and you change both sides at once.

## Conventions

- Types are the documentation. Discriminated unions over bare strings; `RuleId` and `FindingEvidence` are the stable machine contract, `detail` is human prose and never an identity source.
- A finding's identity is `adapter + rule + path + evidence`. Baselines persist exactly that, so any change to evidence shape is a baseline-compatibility change.
- New invariant → new `RuleId` + `FindingEvidence` variant + a `RULE_FOR_KIND` row in `baseline.ts`, or the baseline round-trip rejects it. A rule that reads the advertised surface alone joins `GroundTruthRuleId` instead and gets no row: its notes are reported once, under `groundTruth.findings`, as info, and never baselined. Typecheck then requires its key in `GROUND_TRUTH_RULES`.
- Adapters never call a model, never log in, and never reach a non-loopback endpoint. An adapter that cannot expose a surface without model traffic is out of scope.
- Header values are redacted from the free text of crosscheck-owned diagnostics and reports — not from raw captures or server echoes. Say so rather than implying full redaction. Rule ids, paths, evidence, names, and versions are never redacted: a short value such as `on` would rewrite the machine contract and every baseline written from it.
- `--artifacts` output is local-sensitive. Never commit or attach it.

## Verification is local

There are no GitHub Actions workflows and none should be added. `devcheck` runs on the maintainer's machine where the toolchain lives; a second, weaker copy in CI fails on environment drift and produces a red badge for green code. A `ci.yml` arriving in a diff is a finding to strip, not infrastructure to inherit.

## Issues

Read `skills/report-issue-local/SKILL.md` before `gh issue create`. Every issue is assigned to `cyanheads` at creation.

Labels: primary `bug` / `enhancement` / `documentation`; secondary `engine` (invariant engine and schema comparison), `adapter` (client adapters), `ops` (auth, baselines, running-server usage), `test-infra` (fixture server, E2E suite).

## Releasing

Read `skills/git-wrapup/SKILL.md`. Version lands in `package.json` and a matching `## x.y.z` CHANGELOG heading — devcheck enforces the pair.

## Decisions on record

- **Info tier for output-schema drift.** A dropped output field can mislead a model about a result but drops no argument, so it never fails a run.
- **Latest floats by default.** Adapters resolve their newest release unless pinned, and every run records the version it actually exercised — the drift being measured is a moving target.
- **`claude-code` pins are exact-match, not install directives.** The adapter exercises the installed executable; a mismatched pin reports `adapter-broken` rather than silently testing a different client.
- **The `Exec` seam is a test seam, not an abstraction layer.** It carries exactly the two calls `exec.ts` offers and should not grow to hide process details.
- **Branch `required` never becomes an unconditional requirement.** A requirement inside an `anyOf`/`oneOf` branch holds only when that branch applies, so the normalizer excludes it by construction.
- **`allOf` members merge structure, not values.** A member's `properties`, `required`, and `additionalProperties: false` belong to the level; its constraints, description, and type do not, because `allOf` combines them by conjunction and a merged value would make `constraint-altered` report an artifact of the merge rule. A one-member `allOf` is the exception: it is no conjunction but exactly its member, so the member also supplies values, with the wrapper's own keywords layered on top the way `$ref` siblings are. `{allOf: [{$ref}], description}` is the draft-7 and older-pydantic encoding of a described `$ref`.
