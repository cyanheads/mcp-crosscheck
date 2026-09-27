# Changelog

All notable changes to mcp-crosscheck are documented here.

## 0.2.0 — 2026-09-26

Engine fidelity and a versioned report contract.

- `--json` writes exactly one document to stdout on every exit path, and every document carries `reportVersion: 1`. A run that ends without a report prints `{ "reportVersion": 1, "error": { "kind": "usage" | "runtime", "message": "…" } }` and exits `2` or `1`. JSON mode applies whenever `--json` is passed as a flag, even when other flags fail to parse, a flag missing its value right before `--json` included; a `--json` after `--` belongs to the server command. `--help` and `--version` still print text. The report's `groundTruth` block gains `findings`, `depthLimitedPaths`, and `truncation`, and `pass` now also requires `truncation` to be `null`. (#58)
- Caller mistakes exit `2` as usage errors, raised before any process starts: an unknown flag, a missing flag value, or a value on a switch (#47); an `--adapters` or `--pin` name that is an inherited `Object.prototype` key such as `toString` (#23); an adapter selected twice, which used to run it twice (#26); `--env` with `--http` (#32); an HTTP target URL that does not parse or is not `http:` or `https:` (#39); and a `--timeout` outside 0.001 to 2147483.647 seconds, the Node timer limit (#48). `runCrosscheck` applies the same checks, with `timeoutMs` from 1 to 2147483647.
- On Windows, explicit-relative stdio tokens spelled `.\` and `..\` resolve against the working directory, as `./` and `../` already did. (#54)
- The scratch directory is removed when the `--artifacts` directory cannot be created, and `--help` lists the exact artifact file names.
- New `constraint-altered` rule (info): a constraint keyword present on both sides with a different value. `enum` compares as a set, and a kind mismatch such as a draft-4 boolean `exclusiveMinimum` against a numeric one is a re-encoding, not a change. A restrictive `additionalProperties` (`false` or a value schema) rendered as one that accepts any value is reported the same way. (#29, #65)
- New `description-altered` rule (info) for a tool or property description rendered `truncated` (a prefix of the advertised text, with or without a trailing `…`, `...`, or `[truncated]` marker) or `rewritten`. A rendering that still contains the advertised text, whitespace-normalized, is not reported. `description-lost` now also fires for a description rendered empty or whitespace-only. (#30, #52)
- New `property-excluded` rule (fail): an input property that a rendered `additionalProperties: false` neither lists nor pattern-matches, so a model following the rendered schema can never send it. It is not reported when ground truth already excludes the property. (#63)
- `property-untyped` and untyped `outputSchema` fields are reported only when ground truth itself carries type information. (#24)
- Schema normalization: `properties`, `required`, and `additionalProperties: false` from `allOf` members apply to their level (#40); a one-member `allOf`, such as `{allOf: [{$ref}], description}`, supplies its member's type, description, and constraints (#66); `$ref: "#"` resolves to the whole document, and a property that recurses to the tool root expands once before the loop stops (#51); `items: true` normalizes as an untyped element instead of being dropped (#68).
- Ground truth reads `tools/list` with a permissive result schema, so a tool the `@modelcontextprotocol/sdk` 1.x `Tool` schema rejects (a boolean property schema, a non-object `outputSchema` root) is still captured and compared, and the rejection is reported as an `sdk-v1-rejected` note (#56). A root `$schema` on `inputSchema` or `outputSchema` naming a dialect other than 2020-12, 2019-09, draft-07, or draft-06 is reported as an `unsupported-dialect` note (#35). Both are ground-truth notes: listed once under `groundTruth.findings` and in a ground-truth block of the human report, counted as info, and never baselined. `groundTruthFindings` is exported.
- `tools/list` pagination stops at a repeated cursor, or at the 100-page cap with a `nextCursor` still unfollowed, and never requests a page twice. `groundTruth.truncation` then names the reason and page count, the run fails, the baseline is left byte-for-byte unchanged, and no stale entries are reported. (#31)
- The ground-truth canary lists `tools/list` up to the page that advertises its tool and calls it before requesting another, so the SDK checks `structuredContent` against the tool's `outputSchema`. A failure stops the run with exit `2` before any adapter starts. (#34)
- `groundTruth.depthLimitedPaths` names each property where comparison stopped at the depth limit with advertised fields still below it. `depthLimitedPaths` is exported. (#25)
- Header-value redaction rewrites free text only: finding details, adapter status and canary details, progress lines, and error messages. Rule ids, paths, evidence, tool and server names, the target, and versions keep their values. (#45)
- Baselines canonicalize finding evidence before matching, so an update acknowledges every finding it wrote, and findings that share an identity share one entry (#46). Entries sort by UTF-16 code unit instead of the host locale, so a rewrite produces the same bytes on every machine (#67).
- Baseline compatibility: the next `--update-baseline` can reorder an existing file once. Entries go stale where ground truth now normalizes differently: `property-untyped` and `output-field-untyped` evidence with `groundTruthType: null`; entries whose path or evidence changes now that `allOf` members, one-member `allOf` wrappers, `$ref: "#"`, and `items: true` contribute fields, types, constraints, and `required` names; and entries a header-redacted run wrote with `[REDACTED]` in a path or evidence. A `required-dropped` finding that names a field twice, as when `required` lists it twice, or out of sorted order now matches the entry an update wrote for it. The parser now rejects `constraint-dropped` and `constraint-altered` keywords outside the constraint vocabulary, empty keyword and `required-dropped` name lists, `property-retyped` and `output-field-retyped` evidence whose `from` equals `to`, and the ground-truth rules `sdk-v1-rejected` and `unsupported-dialect`; a keyword or type carrying the `[REDACTED]` marker a 0.1.0 header-redacted run wrote still parses and goes stale. It now accepts an empty path, required name, or type.
- Process execution: a leader's exit SIGKILLs anything it left in its POSIX process group, and no capture or managed exit waits on pipes more than 1 s after the child exits, so a descendant that outlives the package runner no longer defeats the timeout or the teardown (#42). stdout and stderr decode as UTF-8 across pipe chunks (#43). On Windows, bare `npm` launches through Node's npm CLI without a shell, as `npx` already did. A missing `claude` executable is reported as `adapter-broken`, naming the native installer's `claude.exe` that Windows needs; `ExecResult` gains `spawnErrorCode` (#28).
- Dependencies: `@modelcontextprotocol/sdk` ^1.30.0 → ^1.30.1, `zod` ^4.4.3 → ^4.6.5, `@biomejs/biome` 2.5.6 → 2.5.14, `@types/bun` ^1.3.14 → ^1.4.2, `@types/node` 26.1.2 → 26.6.2, `@socketsecurity/bun-security-scanner` ^1.1.2 → ^1.1.3, and `packageManager` bun@1.3.14 → bun@1.4.2.

## 0.1.0 — 2026-08-13

Launch.

- Added portable Windows process lifecycle support: bare `npx` resolves through npm's Node entry point without a shell, timeouts and managed teardown terminate descendant trees with `taskkill`, and Node-core build helpers replace POSIX-only package scripts. Verified on Windows Node 22.21.0 with the built CLI, bundled fixture, timeout, and descendant cleanup. (#16)
- Added a contributor guide and secret-safe GitHub issue forms for reproducible bug reports and deterministic adapter proposals, with local gate and opt-in client-lane coverage kept in sync with the repository. (#15)
- Reconciled the public README, CLI flags, package metadata, archive contents, release history, and final Inspector, mcpo, Codex, and Claude Code verification lanes for the 0.1.0 release. (#17)

## 0.0.5 — 2026-08-13

Operations.

- Streamable HTTP targets now accept repeatable headers across the SDK, Inspector, mcpo, and Codex adapters. Header values are redacted from rendered diagnostics and reports, while raw capture artifacts remain explicitly sensitive. (#12)
- The Codex adapter can capture authenticated HTTP targets through an isolated child environment without persisting header values in TOML, argv, or reports. (#13)
- Findings now carry structured evidence, and strict versioned baseline files classify new, acknowledged, and stale findings with deterministic, atomic updates. Failed adapter surfaces cannot be acknowledged. (#14)

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
