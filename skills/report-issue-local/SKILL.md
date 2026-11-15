---
name: report-issue-local
description: >
  File a bug, enhancement, or adapter request against the mcp-crosscheck repo. Covers dedup search, title and label conventions, body structure, and the redaction bar for a public repo.
metadata:
  author: cyanheads
  version: "1.1"
  audience: external
  type: workflow
---

## When to use

Before every `gh issue create` in this repo. Triggers:

- The invariant engine reports a finding that is not real drift, or misses drift that is
- An adapter fails to launch, capture, or classify a client the way its profile says it does
- The CLI mishandles a flag, exit code, or target spec
- A baseline round-trip rejects, drops, or duplicates an entry it should have kept
- Docs describe behavior the code does not have

## Before filing

1. **Search existing issues.** Close match → comment on it instead of filing a duplicate, unless the symptom or scope is distinct enough to track separately. Read a candidate's body and thread together, and check what already references it:

```sh
gh issue list --search "keyword or error text" --state all
gh issue view <number> --json title,body,comments
gh api 'repos/cyanheads/mcp-crosscheck/issues/<number>/timeline' --paginate \
  --jq '.[] | select(.event=="cross-referenced") | .source.issue | "\(.repository.full_name)#\(.number) — \(.title)"'
```

2. **Reproduce it.** The smallest command or the smallest `compareSurface` call that shows the behavior. A finding-engine bug reproduces against `dist/` in a few lines:

```sh
bun run rebuild
node -e "
import('./dist/index.js').then(({ compareSurface, renderedToolFromJsonSchema }) => {
  /* build the ground-truth tool and the rendered tool, print compareSurface */
});
"
```

3. **Pin the versions.** `mcp-crosscheck --version`, the resolved client version from the report, the transport, and the OS/Node/Bun triple. The bug form requires all of them.

## Redact before posting

This repo is public. `--artifacts` output is local-sensitive: `ground-truth.json` and `mcpo.openapi.json` carry server-controlled data, and raw `codex.request.json` / `claude-code.request.json` carry prompt, session, and client metadata. Never attach them raw. Replace credentials, auth headers, tokens, and private endpoints with obvious placeholders (`REDACTED`) — partial masking is not redaction.

## Filing

Three forms live in `.github/ISSUE_TEMPLATE/`: **Bug report**, **Feature request**, **Adapter request**. Blank issues are enabled for people thinking out loud; an agent always files through a form, after the triage above. Use `--web` to fill the form interactively, or match its field headings, in form order, in a `--body` for non-interactive use:

| Form | Field headings |
|:--|:--|
| Bug report | mcp-crosscheck version · Adapter · Resolved client version · Target transport · Environment · Description · Minimal reproduction · Report or redacted output · Actual behavior · Expected behavior · Additional context (optional) · Sensitive data check |
| Feature request | Area · Gap · Proposal · Proposed severity tier · Compatibility impact · Scope and out of scope (optional) · Alternatives considered (optional) · Determinism |
| Adapter request | Client · Official release source · Target transports · Rendered MCP surface · Version resolution · Deterministic capture path · Local prerequisites · Known limitations · Capture boundary |

A checkbox field renders as `- [x] <the option's label>` under its heading.

```sh
gh issue create --template "Bug report" --web
```

Non-interactive — route the body through a quoted-delimiter heredoc so backticks and apostrophes survive:

```sh
gh issue create \
  --title "bug(engine): concise description" \
  --label "bug" --label "engine" \
  --assignee "cyanheads" \
  --body "$(cat <<'ISSUE'
### mcp-crosscheck version

0.1.0

### Adapter

Not adapter-specific

...
ISSUE
)"
```

### Titles

`type(scope): description` — type is `bug`, `feat`, `docs`, or `chore`; scope is `engine`, `adapter`, a specific adapter name (`inspector`, `mcpo`, `codex`, `claude-code`), `cli`, `baseline`, or `exec`.

- `bug(cli): --adapters accepts inherited Object.prototype keys`
- `feat(engine): report a changed constraint value, not only a dropped keyword`
- `docs(adapters): record the measured Codex 0.147 namespace wrapper`

### Labels

Exactly one primary, plus any area and cross-cutting labels that apply. A form filled on the web applies its primary for you (an adapter request also gets `adapter`); a non-interactive `gh issue create --body` applies none, so pass every label with a repeated `--label`.

| Primary | When |
|:--|:--|
| `bug` | Something broken |
| `enhancement` | New capability or improvement, a new adapter included |
| `documentation` | Docs are wrong, missing, or misleading |

| Area | When |
|:--|:--|
| `engine` | Invariant engine, schema normalization, findings, baselines |
| `adapter` | Client adapters and their capture profiles |
| `ops` | Auth, headers, baselines in CI, running-server usage |
| `test-infra` | Fixture server, E2E suite, test tooling |

| Cross-cutting | When |
|:--|:--|
| `regression` | Worked before, broken after a change |
| `performance` | Memory, CPU, latency, or resource usage |
| `security` | Vulnerability or hardening work — a vulnerability itself goes to the private advisory form, never a public issue |
| `breaking-change` | Changes the library API, the report shape, or baseline identities |
| `surplus-token-idea` | Worth exploring when token budget allows |
| `duplicate` | Closed in favor of another issue |

Every issue is assigned to `cyanheads` at creation: `--assignee cyanheads`.

## Body structure

Scannable, concrete, self-contained. A bug reads in about 150 words and a feature in about 250, code and output excluded; one or two sentences per bullet.

- **Lead with the specific.** Name the rule, adapter, flag, or path. "`property-untyped` fires when ground truth is itself untyped" beats "the engine has false positives."
- **Show the reproduction, then the actual and expected output.** For engine issues, paste the `Finding[]` the comparison returns.
- **Anchor claims to code.** `src/invariants.ts:123` is checkable; "the comparison logic" is not.
- **Separate `### Scope` from `### Out of scope`** on anything larger than a one-line fix — the boundary pre-empts scope-creep debates.
- **Say which tier you are proposing.** `fail` breaks a consumer's build; `info` never does. Moving a rule between tiers is a behavior change for everyone with the tool in CI.
- **Note baseline impact.** A change to `FindingEvidence` shape changes persisted identities and invalidates existing baselines. Call it out explicitly.
- **Link related work once.** A `Related: #N` line near the top when the issue grows from another; `owner/repo#N` for an issue in another repo, such as a client's own tracker.
- **Cut ceremony.** No "this issue covers", no "as discussed", no offers to open a PR.

## Following up

```sh
gh issue view <number> --json title,body,comments
gh issue comment <number> --body "Additional findings..."
gh issue close <number> --reason completed --comment "Fixed in <commit>"
```

## Checklist

- [ ] Searched existing issues; close matches commented rather than duplicated
- [ ] Reproduction included, and it actually runs
- [ ] Credentials, headers, tokens, and private endpoints redacted; no raw artifacts attached
- [ ] Title follows `type(scope): description`
- [ ] Filed through a form's headings, not a blank issue
- [ ] One primary label plus the area and cross-cutting labels that apply; assigned to `cyanheads`
- [ ] Severity tier and baseline impact stated when the change touches findings
