---
name: report-issue-local
description: >
  File a bug, enhancement, or adapter request against the mcp-crosscheck repo. Covers dedup search, title and label conventions, body structure, and the redaction bar for a public repo.
metadata:
  author: cyanheads
  version: "1.0"
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

1. **Search existing issues.** Close match → comment on it instead of filing a duplicate, unless the symptom or scope is distinct enough to track separately.

```sh
gh issue list --search "keyword or error text" --state all
gh issue view <number> --comments
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

Three forms live in `.github/ISSUE_TEMPLATE/`: **Bug report**, **Feature request**, **Adapter request**. Use `--web` to fill the form interactively, or match its field headings in a `--body` for non-interactive use.

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

Exactly one primary, plus any area labels that apply.

| Primary | When |
|:--|:--|
| `bug` | Something broken |
| `enhancement` | New capability or improvement |
| `documentation` | Docs are wrong, missing, or misleading |

| Area | When |
|:--|:--|
| `engine` | Invariant engine, schema normalization, findings, baselines |
| `adapter` | Client adapters and their capture profiles |
| `ops` | Auth, headers, baselines in CI, running-server usage |
| `test-infra` | Fixture server, E2E suite, test tooling |

Every issue is assigned to `cyanheads` at creation: `--assignee cyanheads`.

## Body structure

Scannable, concrete, self-contained. One or two sentences per bullet.

- **Lead with the specific.** Name the rule, adapter, flag, or path. "`property-untyped` fires when ground truth is itself untyped" beats "the engine has false positives."
- **Show the reproduction, then the actual and expected output.** For engine issues, paste the `Finding[]` the comparison returns.
- **Anchor claims to code.** `src/invariants.ts:123` is checkable; "the comparison logic" is not.
- **Separate `### Scope` from `### Out of scope`** on anything larger than a one-line fix — the boundary pre-empts scope-creep debates.
- **Say which tier you are proposing.** `fail` breaks a consumer's build; `info` never does. Moving a rule between tiers is a behavior change for everyone with the tool in CI.
- **Note baseline impact.** A change to `FindingEvidence` shape changes persisted identities and invalidates existing baselines. Call it out explicitly.
- **Cut ceremony.** No "this issue covers", no "as discussed", no offers to open a PR.

## Following up

```sh
gh issue view <number> --comments
gh issue comment <number> --body "Additional findings..."
gh issue close <number> --reason completed --comment "Fixed in <commit>"
```

## Checklist

- [ ] Searched existing issues; close matches commented rather than duplicated
- [ ] Reproduction included, and it actually runs
- [ ] Credentials, headers, tokens, and private endpoints redacted; no raw artifacts attached
- [ ] Title follows `type(scope): description`
- [ ] One primary label plus area labels; assigned to `cyanheads`
- [ ] Severity tier and baseline impact stated when the change touches findings
