---
name: git-wrapup
description: >
  Land working-tree changes in mcp-crosscheck as a stack of logical commits, and cut a release when the work ships — gates, version sync, changelog, tag, and npm publish order.
metadata:
  author: cyanheads
  version: "1.0"
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
CROSSCHECK_E2E_NETWORK=1 bun test tests/e2e.test.ts      # inspector + mcpo, needs uv on PATH
CROSSCHECK_E2E_CODEX=1 bun test tests/e2e.test.ts
CROSSCHECK_E2E_CLAUDE_CODE=1 bun test tests/e2e.test.ts
```

A validated client capture that changed also needs a dated measurement in `docs/adapters.md`.

## Commits

Group by logical concern, never one-file-per-commit ceremony and never a multi-concern mega-commit. Conventional Commits with a scope: `feat|fix|refactor|chore|docs|test|build(scope): message`. Scopes match the module: `engine`, `adapter`, `cli`, `baseline`, `exec`, `test-infra`, `docs`.

Subject around 50 characters. Body of one or two lines carrying the why or what the diff does not show; skip line-by-line recaps. Reference the issue the commit closes: `(#12)`.

Never split one file's changes across commits — the file is the atomic boundary.

No marketing adjectives, no references to the conversation that produced the change, no trailing attributions.

## Releasing

A release is one commit stack plus metadata on top. For a single cohesive change the version bump rides with the work; for several distinct efforts the per-effort commits land first and `chore(release): <version> — <theme>` goes on top.

1. **Version.** `package.json` `version`. The magnitude is the maintainer's call — never inferred.
2. **CHANGELOG.** A new `## x.y.z — YYYY-MM-DD` heading, a one-line theme, then flat bullets naming the behavior change and its issue numbers. Never `[Unreleased]`. `devcheck` fails when the heading does not match `package.json`, so the pair moves together.
3. **Gate again.** `bun run devcheck` after the bump — the changelog step is part of it.
4. **Commit, then tag.** Annotated tag `vX.Y.Z`. The annotation subject is the theme with **no version number** (GitHub prepends `vX.Y.Z:` to the release title), then flat bullets for the notable changes with issue backlinks. Terse — depth lives in the CHANGELOG.
5. **Push** the commits and the tag.
6. **Publish.** `npm publish` runs `prepublishOnly` → `bun run rebuild`, so the tarball is built from a clean `dist/`. The package ships `dist/` and `CHANGELOG.md` only.
7. **GitHub release** from the tag: `gh release create vX.Y.Z --notes-from-tag`.
8. **Close the issues** the release resolved, with a one-line note on what landed.

## Boundaries

- Never `git stash`. Never `reset --hard`, `checkout -- .`, `restore .`, or `clean -f`.
- No git worktrees.
- Do not add GitHub Actions workflows that re-run the local gate — verification is local by design.
- Never commit `--artifacts` output, raw client captures, or a `.env`.

## Checklist

- [ ] `bun run devcheck` clean — exit 0, zero warnings
- [ ] Opt-in adapter lane run when a capture path changed
- [ ] `docs/adapters.md` carries a dated measurement when a client rendering changed
- [ ] Commits grouped by concern, conventional, issue-referenced
- [ ] Release only: `package.json` version and `## x.y.z` CHANGELOG heading match
- [ ] Release only: annotated tag without the version in its subject, pushed with the commits
- [ ] Release only: `npm publish`, GitHub release, issues closed
