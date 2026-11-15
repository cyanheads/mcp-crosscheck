---
name: git-wrapup
description: >
  Land working-tree changes in mcp-crosscheck as a stack of logical commits, and, when the work ships, carry it to an open release PR — branch, per-commit snapshot gate, version and changelog, release commit, PR body. Stops at the open PR; `release-pr-review` and `release-and-publish` take it from there.
metadata:
  author: cyanheads
  version: "1.3"
  audience: maintainer
  type: workflow
---

## Gate first

Nothing is committed until this is clean:

```sh
bun run devcheck
```

Exit 0 **and** zero warnings. Biome runs with `--error-on-warnings`, so a green run means zero diagnostics. Run it raw — it auto-fixes formatting with `--write`, and filtering the output hides what it changed. Review those changes before staging.

When the change touches an adapter's capture path, run its opt-in lane too — the hermetic suite cannot see a real client's rendering change:

```sh
CROSSCHECK_E2E_NETWORK=1 bun test tests/e2e/inspector.test.ts tests/e2e/mcpo.test.ts      # inspector + mcpo, needs uv on PATH
CROSSCHECK_E2E_CODEX=1 bun test tests/e2e/codex.test.ts
CROSSCHECK_E2E_CLAUDE_CODE=1 bun test tests/e2e/claude-code.test.ts
```

A validated client capture that changed also needs a dated measurement in `docs/adapters.md`.

## Commits

Group by logical concern, never one-file-per-commit ceremony and never a multi-concern mega-commit. Conventional Commits with a scope: `feat|fix|refactor|chore|docs|test|build(scope): message`. Scopes match the module: `engine`, `adapter`, `cli`, `baseline`, `exec`, `test-infra`, `docs`, `community`.

Subject around 50 characters. Body of one or two lines carrying the why or what the diff does not show; skip line-by-line recaps. Reference the issues a commit resolves as bare backlinks, `(#12)` — never a closing keyword (`Closes #12`, `Fixes #12`), which would close the issue before its close-out comment lands.

Never split one file's changes across commits — the file is the atomic boundary. Stage and commit by pathspec, never the bare index, so nothing staged earlier rides along:

```sh
git add <paths>
git commit --only <paths> -m "<subject>" -m "<body>"
```

No marketing adjectives, no references to the conversation that produced the change, no trailing attributions.

## Releasing

A release is one commit stack plus metadata on top. For a single cohesive change the version bump rides with the work; for several distinct efforts the per-effort commits land first and `chore(release): <version> — <theme>` goes on top.

Every release runs in gated Release PR mode (`CLAUDE.md` § Publishing): this skill ends at an open PR, a `skills/release-pr-review/SKILL.md` pass reviews it, and `skills/release-and-publish/SKILL.md` merges, tags, and publishes. Nothing here tags, merges, pushes `main`, or publishes.

### 1. Branch before anything is committed

The version is the maintainer's call — taken from the brief, never inferred. Once it is known:

```sh
git branch --show-current                              # main
git branch --no-merged main --list 'release/*'         # nothing: an unmerged release is a halt
git ls-remote --heads origin release/<version>         # nothing
gh pr list --head release/<version> --state all        # nothing
git switch -c release/<version>                        # uncommitted work rides along
```

A hit on any check means an earlier run claimed this version or never shipped: halt and report it. A `release/*` branch already merged into `main` is a leftover — delete it with `git branch -d` and continue. `git branch --show-current` must print `release/<version>` before every commit that follows.

### 2. Commit the work, each commit green on its own

Read `git diff HEAD` and every untracked file in full first. Then commit the work concerns, before the version moves, so a file a work concern shares with the version (a doc that pins it) goes whole into that concern's commit.

Every commit must build and pass its tests at its own SHA. Check each proposed group before committing it, in a scratch export under a temporary index — never by staging in the real index and backing out:

```sh
S=$(mktemp -d)
GIT_INDEX_FILE="$S/index" git read-tree HEAD
GIT_INDEX_FILE="$S/index" git add -- <paths-for-this-commit>
GIT_INDEX_FILE="$S/index" git checkout-index -a --prefix="$S/tree/"
ln -s "$PWD/node_modules" "$S/tree/node_modules"
(cd "$S/tree" && bun run typecheck && bun run build && bun test)
```

The temporary index leaves the real index and working tree untouched. A failure the candidate has and `HEAD` does not means the group depends on files outside it: merge the dependent groups and check again. A failure `HEAD` shares is a snapshot-method problem (a test that needs `.git`, a path through the symlink) to resolve before judging the group. Never commit to find out, and never rewrite history to fix a grouping. Remove the scratch directory by its literal path when done.

A dependency bump is its own `chore(deps)` commit carrying `package.json` and `bun.lock`, landed before any commit that uses what it brings.

### 3. Version and changelog

1. **Version.** `package.json` `version`, to the value in the brief.
2. **CHANGELOG.** A new `## x.y.z — YYYY-MM-DD` heading, a one-line theme, then flat bullets naming each behavior change and its issue numbers. Never `[Unreleased]`, never a rewrite of an earlier entry. Dependency moves name the package and the arrow: `zod` ^4.6.5 → ^4.6.7.
3. **Other version-bearing text.** `rg -n "<previous-version>" README.md CLAUDE.md docs/` — resolve each hit; a historical mention stays.
4. **Gate again.** `bun run devcheck` — its changelog step fails when the heading does not match `package.json`.

### 4. Release commit

One commit on top of the work stack carrying only the release artifacts — `package.json`, `CHANGELOG.md`, and any doc whose only change is the version:

```sh
git add <release-artifact-paths>
git commit --only <release-artifact-paths> -m "chore(release): <version> — <theme>" -m "<body>"
```

Anything else still uncommitted (a formatter fix, a gate fix) is committed on its own first, never folded in.

### 5. Push the branch and open the PR

```sh
git push -u origin release/<version>
gh pr create --base main --head release/<version> --title "chore(release): <version> — <theme>" --assignee @me --body-file <scratch-file>
```

Title: the release commit's subject, verbatim. Body: always through `--body-file`, written outside the repo — never an inline `--body`, where backticks run as command substitution. No reviewer: GitHub refuses a review request on the author's own PR, and the review record is the summary comment `release-pr-review` leaves.

The body is the release digest. Its `## Changes` bullets and final link become the annotated tag's body verbatim at release time, so this is where the release notes get reviewed:

```
<theme — the CHANGELOG entry's one-line theme>

## Changes

- <notable user-facing change> (#N)
- <notable user-facing change> (#N)
- <ONE grouped line for the minor and internal changes>
- deps: `@modelcontextprotocol/sdk` ^1.30.1 → ^1.32.2 (+ dev-dep bumps)

## Gates

- `bun run devcheck` on the finished tree: exit 0, <N> pass / <N> skip / 0 fail, zero warnings
- `bun run rebuild`: exit 0
- <each opt-in lane run, with the client version it resolved>

[CHANGELOG v<version>](https://github.com/cyanheads/mcp-crosscheck/blob/main/CHANGELOG.md)
```

- **`## Changes` is a headline digest of the CHANGELOG entry**: flat bullets, no section headers; every change the entry names stays visible, minor ones sharing one grouped bullet; deps on one line; no narrative, no marketing adjectives. Every claim traces to the diff and to the entry.
- **Issue references are bare `(#N)` backlinks.** A closing keyword would close the issue on merge, before its close-out comment.
- **Outside reporters are thanked on their own bullet**, `(#N, thanks @user!)`, as the CHANGELOG entry does.
- **`## Gates` is the one release surface that carries gate results.** It never enters the tag.
- **The changelog link is the last line**, with a blank line above it.

### 6. Stop

Report the PR URL, the branch, and the commit stack (`git log --oneline main..HEAD`). The tree is clean, nothing is tagged (`git tag --points-at HEAD` prints nothing), and `main` is untouched.

## Boundaries

- Never `git stash`. Never `reset --hard`, `checkout -- .`, `restore .`, or `clean -f`. Never `--amend` or force-push.
- No git worktrees.
- No tag, no push of `main`, no publish — the release-branch push and the PR are the only remote writes.
- Do not add GitHub Actions workflows that re-run the local gate — verification is local by design.
- Never commit `--artifacts` output, raw client captures, or a `.env`.

## Checklist

- [ ] `bun run devcheck` clean — exit 0, zero warnings
- [ ] Opt-in adapter lane run when a capture path changed
- [ ] `docs/adapters.md` carries a dated measurement when a client rendering changed
- [ ] Commits grouped by concern, conventional, issue-referenced without closing keywords, committed by pathspec
- [ ] Release only: `release/<version>` created before the first commit; no conflicting branch or PR
- [ ] Release only: each commit checked in a temporary-index snapshot before it landed
- [ ] Release only: `package.json` version and `## x.y.z` CHANGELOG heading match; release commit on top
- [ ] Release only: branch pushed, PR open with the digest body and assigned; nothing tagged, `main` untouched
