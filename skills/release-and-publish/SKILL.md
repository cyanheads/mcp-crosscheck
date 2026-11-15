---
name: release-and-publish
description: >
  Ship a reviewed mcp-crosscheck release PR: final gate, fast-forward `main` to the release branch, cut the annotated tag on the reviewed head, push, publish to npm, create the GitHub release, verify both are live, and close the issues the release resolved. Runs after `git-wrapup` opened the PR and `release-pr-review` returned `finished`. Retries transient network failures; halts with a partial-state report otherwise.
metadata:
  author: cyanheads
  version: "1.0"
  audience: maintainer
  type: workflow
---

## Preconditions

- HEAD is on `release/<version>`, pushed, with an open PR whose head SHA equals local HEAD
- The caller has confirmed the `release-pr-review` pass returned `finished`. Without that confirmation, halt: this skill never decides a review is done
- `git log main..HEAD --format=%s` contains `chore(release): <version> — <theme>`, with only the review pass's commits above it
- `package.json` carries `<version>` and `CHANGELOG.md` its `## <version> — YYYY-MM-DD` heading
- No tag `v<version>` exists yet, and the working tree is clean

If any is missing, halt and say which. Never redo wrapup or review work from inside this skill.

## Failure protocol

Network-bound steps (pushes, `npm publish`, `gh release`, registry checks) retry a transient failure up to twice, about 5 s and then 15 s apart: `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, `connection reset`, `timed out`, HTTP 502/503/504. Every other step halts on its first non-zero exit.

Signals that a step already succeeded on an earlier run — proceed past them:

- npm: `You cannot publish over the previously published versions`
- Tag: `already exists`, with the tag pointing at HEAD. A tag pointing anywhere else is a conflict: halt with both SHAs, and never move or delete it
- GitHub release: `already exists` — run `gh release edit v<version> --title "v<version>: <tag subject>"` and continue

On a halt, report the failing step, its exact output, the retry count, and which destinations already have the release: `main` pushed, tag pushed, npm, GitHub release.

## Steps

### 1. Sanity check

```sh
git branch --show-current                          # release/<version>
git status --short                                 # empty
git log main..HEAD --format=%s                     # the release commit, review commits above it only
gh pr view --json number,state,headRefOid,body     # OPEN, headRefOid == git rev-parse HEAD
```

Keep the PR `number`, `headRefOid`, and `body`: steps 3 and 4 need them after the checkout moves to `main`.

### 2. Gate

```sh
bun run devcheck
bun run rebuild
```

Both exit 0, and devcheck with zero warnings. The opt-in client lanes ran at wrapup and are recorded in the PR body's `## Gates`; they are not repeated here.

### 3. Fast-forward `main`

```sh
git switch main
git pull --ff-only origin main
git merge --ff-only release/<version>
git rev-parse HEAD                                 # must equal the PR's headRefOid
```

The stack lands on `main` byte-identical: same SHAs, same signatures. GitHub marks the PR merged once its head commit is on `main`. Never merge through the GitHub UI or `gh pr merge` — squash destroys the stack, rebase-and-merge rewrites every SHA, a merge commit breaks the linear history. If `--ff-only` refuses, `main` moved under the release branch: halt and report. Nothing has been created yet, and rebasing would change the SHAs the review approved, so that call belongs to the caller.

### 4. Cut the annotated tag

The tag body is the PR body's `## Changes` bullets plus its final changelog line, verbatim, with ` · release PR #<N>` appended to that line. Drop the theme line, `## Gates`, and the headings. That digest was written at wrapup and reviewed on the PR; re-authoring it here would publish unreviewed words.

The subject is the one part written fresh: one short theme, about 60 characters and never over 72, no version number (GitHub prepends `v<version>:` to the release title), no semicolons, no list of changes.

```
<subject>

- <notable change> (#N)
- <grouped minor changes>
- deps: `@modelcontextprotocol/sdk` ^1.30.1 → ^1.32.2

[CHANGELOG v<version>](https://github.com/cyanheads/mcp-crosscheck/blob/main/CHANGELOG.md) · release PR #<N>
```

Write the message to a scratch file outside the repo through a quoted-delimiter heredoc, and tag from the file:

```sh
git tag -a v<version> --cleanup=whitespace -F <scratch-file>
```

Never `-m`: the body carries backticks, which a double-quoted string runs as command substitution, and apostrophes, which end a single-quoted one. `--cleanup=whitespace` is load-bearing — the default `strip` deletes `#`-leading lines as comments, and `verbatim` appends a signature flush against the last line, where git cannot parse it and the whole signature block publishes into the release body.

Verify before pushing:

```sh
git for-each-ref refs/tags/v<version> --format='%(objecttype) %(contents:subject)'   # "tag <subject>"
git tag -l v<version> --format='%(if)%(contents:signature)%(then)signed%(else)unsigned%(end)'
git cat-file -p v<version>
```

The first line reads `tag`, the subject meets the rules above, the signature check prints `signed` when tag signing is configured, and the body has no `#` headings, no signature text inside it, and the changelog link last. A tag that fails is local and seconds old: delete it with `git tag -d v<version>` and cut it again. That is the one tag deletion that needs no authorization.

### 5. Push

```sh
git push origin main
git push origin v<version>
```

`main` first, then the tag. Confirm `gh pr view <N> --json state` reports `MERGED`, then delete the branch: `git push origin --delete release/<version>` and `git branch -d release/<version>`. A PR still `OPEN` or `CLOSED` means the pushed `main` lacks its head commit — stop and report before publishing.

### 6. Publish to npm

```sh
npm pack --dry-run
npm publish
```

The dry run lists `dist/` (with `dist/cli.js` and `dist/launch-target.js`), `CHANGELOG.md`, and the metadata npm always includes — nothing from `tests/` or `scripts/`. `npm publish` runs `prepublishOnly` → `bun run rebuild`, so the tarball is built from a clean `dist/`. The package is unscoped `mcp-crosscheck`; never add a scope. An OTP prompt from two-factor auth is expected and the maintainer completes it.

### 7. Create the GitHub release

```sh
gh release create v<version> --verify-tag --notes-from-tag --title "v<version>: <tag subject>"
```

`--notes-from-tag` publishes the tag body as the release notes. Without `--title` the release name is empty.

### 8. Verify both are live

A zero exit is not proof the artifact is reachable. Wait for npm to serve the version in one bounded foreground loop, then check it from outside the repo — inside it, `npx` resolves the local workspace package instead:

```sh
for i in $(seq 1 15); do
  curl -sf -m 15 -o /dev/null "https://registry.npmjs.org/mcp-crosscheck/<version>" && echo served && break
  sleep 20
done
npm view mcp-crosscheck@<version> version
(cd "$(mktemp -d)" && npx -y mcp-crosscheck@<version> --version)
gh release view v<version> --json name,tagName,url
gh api repos/cyanheads/mcp-crosscheck/releases/latest --jq .tag_name      # v<version>
```

npm's publish-time scanning can hold an accepted version back for several minutes; a loop that ends unserved runs again before anything is called failed.

### 9. Close the resolved issues

For each `(#N)` backlink in the tag body whose issue is still open, close it with a one-line note on what landed:

```sh
gh issue close <N> --reason completed --comment "Fixed in v<version>: <what landed>."
```

An issue the release advanced but did not finish stays open, with a comment naming what landed and what remains.

### 10. Report

- npm: `https://www.npmjs.com/package/mcp-crosscheck/v/<version>`
- GitHub release: `https://github.com/cyanheads/mcp-crosscheck/releases/tag/v<version>`
- The tag SHA, the merged PR, and the issues closed

## Constraints

- **Fast-forward only.** No merge commit, no rebase, no GitHub merge button.
- **No force-push**, of `main`, the tag, or anything else.
- **Never stash. Never destructive.** No `git stash`, `reset --hard`, `restore .`, `clean -f`, `checkout -- .`. No worktrees.
- **Tags move only in step 4**, before the push. A pushed tag is permanent.

## Checklist

- [ ] On `release/<version>`, tree clean, PR open with head == HEAD, review confirmed `finished`
- [ ] `bun run devcheck` (zero warnings) and `bun run rebuild` pass
- [ ] `main` fast-forwarded locally; HEAD equals the PR's `headRefOid`
- [ ] Annotated tag on HEAD: fresh subject without the version, body lifted from the PR's `## Changes` plus the changelog link and `· release PR #<N>`, cut with `--cleanup=whitespace -F`, signature parses
- [ ] `main` pushed, then the tag; PR `MERGED`; remote and local `release/<version>` deleted
- [ ] `npm pack --dry-run` lists only the shipped files; `npm publish` succeeded
- [ ] GitHub release created with `--title "v<version>: <tag subject>"`
- [ ] npm serves the version, `npx` from outside the repo reports it, the GitHub release is latest
- [ ] Resolved issues closed with a note; partly-addressed ones commented and left open
