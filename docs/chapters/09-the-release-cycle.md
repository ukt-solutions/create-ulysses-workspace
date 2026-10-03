# The Release Cycle

The release cycle is how accumulated work becomes a versioned artifact. A release is now a thin operation: `/release` bumps the version, merges the bump through a PR, tags the merge commit, and publishes a forge release whose notes the forge generates from merged PR titles. The workspace keeps no release-notes files of its own — the detail behind each change already lives in the issue and the PR body, and the forge is where readers of a published release actually look.

This chapter traces that path and notes who opts out of it.

---

## How /release Works

The `/release` skill is a per-repo operation — each repo has its own release cadence. When invoked:

1. **Version and repo.** `/release {version}` or ask; ask which repo (defaulting to the `primary` one in `workspace.json`). With no version given, it shows the merged PRs since the last tag so the operator can judge patch/minor/major. Pre-v1.0 breaking changes are a minor bump.

2. **Preflight the tag.** If `v{version}` already exists on origin, stop and ask — reuse, investigate, or pick another version. Never force-push a tag.

3. **Bump on a branch.** A task worktree on `release/v{version}` carries the version bump: `package.json` (and `package-lock.json`'s top-level version fields) set to the new version, committed as `chore: release v{version}`. A repo with no version file skips the commit and tags the default-branch head instead.

4. **Merge.** Push the branch, open a PR through the forge adapter, and merge (squash, delete branch) after the operator confirms.

5. **Leak audit (optional).** Workspaces or repos that configure `release.leakPatterns` in `workspace.json` get a scripted scan of exactly what the release publishes — the `npm pack` file list for a publishable package, else the files changed since the last tag, plus the release's commit subjects — before the tag is pushed. Matches stop the release for a human decision; the skill never edits files to silence the audit. Workspaces that configure no patterns skip the step entirely.

6. **Tag and publish.** Tag the merge commit `v{version}` and push the tag. If the repo's publish workflow (`.github/workflows/publish.yml`) creates the release itself, the skill leaves that to the workflow, watches its run, and confirms the release exists; otherwise it creates the forge release with generated notes (still watching any publish run). A failed run is reported, not thrown.

7. **Tear down** the release worktree and report the PR, tag, release URL, and publish status.

## Where the Notes Come From

The forge. GitHub's generated notes — merged PR titles, grouped and linked — are the release notes. Because PR bodies are written from the session tracker, the linked issue, and the commits (a short summary plus a Verification section), everything a reader needs is already at the forge. Duplicating that into workspace files bought nothing: workspaces that don't publish never consumed the notes, and a template-level notes mechanism would clash with projects that already use changesets, semantic-release, or their own tooling.

A repo's `CHANGELOG.md`, if it has one, is historical — this skill does not write it. Repos with their own release tooling simply don't use this skill; their bumps and tags happen in their own pipeline.

## Version Numbering

Versions are assigned at release time, not pre-planned. The convention:

- **Patch** (0.x.**Y**): Bug fixes, design debt, small improvements.
- **Minor** (0.**X**.0): New features or significant template changes.
- **Major** (**X**.0.0): Breaking changes to conventions, schema, or skill interfaces.

The version number describes what shipped, not when it was planned. A feature you expected to be a minor might turn out to be a patch if the actual change was small.

---

## Key Takeaways

- `/release` bumps, merges through a PR, tags, and publishes a forge release with generated notes.
- Release notes come from the forge (merged PR titles); the workspace writes none.
- The optional leak audit (`release.leakPatterns`) scans the publish surface before the tag is pushed; matches stop for a human decision.
- Repos with their own release tooling ignore `/release` entirely.
- Versions are assigned at release time based on what shipped, not pre-planned.
