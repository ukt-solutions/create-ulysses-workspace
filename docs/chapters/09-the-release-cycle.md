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

5. **Leak audit and consumer-facing review.** Two looks at what the release is about to publish, both before the tag is pushed, because a published version cannot be taken back. The *pattern audit* is optional: workspaces or repos that configure `release.leakPatterns` in `workspace.json` get a scripted scan of exactly what the release publishes — the `npm pack` file list of the root package and of each non-private npm workspace package, the files changed since the last tag, any paths named in `release.consumerFacing` (documents that ship whether or not they changed, such as an API spec), and every commit message in the range. Matched spans are masked in the report, and files, packages, or configured paths the script could not read, enumerate, or find are listed rather than dropped; matches stop the release for a human decision, and the skill never edits files to silence the audit. With no patterns configured the step still runs and exits 0 having scanned nothing. The *consumer-facing review* is on by default (`release.consumerReview: false` opts out) and advisory: when a README, CHANGELOG, `package.json` (a bump of its `version` alone does not count — every release makes one) or other consumer-facing file changed since the last tag, one read-only subagent reads those files for passages a consumer could not act on or that expose internal detail — operator procedures, internal infrastructure, internal identifiers, private repository names, local paths — and the operator marks each finding fix, accept, or dismiss. It never blocks the release and never edits a file.

6. **Tag and publish.** Tag the merge commit `v{version}` and push the tag. If the repo's publish workflow (`.github/workflows/publish.yml`) creates the release itself, the skill leaves that to the workflow, watches its run, and confirms the release exists; otherwise it creates the forge release with generated notes (still watching any publish run). A failed run is reported, not thrown.

7. **Tear down** the release worktree and report the PR, tag, release URL, and publish status.

## Where the Notes Come From

The forge. GitHub's generated notes — merged PR titles, grouped and linked — are the release notes. Because PR bodies are written from the branch's commits, the linked issue and the chat's notes (a short summary plus a Verification section), everything a reader needs is already at the forge. Duplicating that into workspace files bought nothing: workspaces that don't publish never consumed the notes, and a template-level notes mechanism would clash with projects that already use changesets, semantic-release, or their own tooling.

A repo's `CHANGELOG.md`, if it has one, is historical — this skill does not write it. Repos with their own release tooling simply don't use this skill; their bumps and tags happen in their own pipeline.

## Version Numbering

Versions are assigned at release time from what shipped, not planned in advance. The number tracks the template — what lands in a workspace — so a release is judged by what `--upgrade` and `/workspace-update` put an existing workspace through:

- **Patch** (0.x.**Y**): fixes that leave the documented contract as it is, plus documentation and wording corrections.
- **Minor** (0.**X**.0): something new — a skill, rule, hook, optional `workspace.json` field or CLI flag — or a change that ships with a migration `/workspace-update` runs itself.
- **Major** (**X**.0.0): an existing workspace needs a manual step, or something on the contract changes behaviour — a skill, rule, hook or field is removed or renamed, the layout moves, the minimum Node version goes up.

Before 1.0.0 a breaking change is a minor bump, because a `0.x` version does not claim stability yet. [VERSIONING.md](../../VERSIONING.md) defines the contract these refer to, when a migration counts as automatic, the dist-tags each release ships under, and what 1.0 does not promise.

---

## Key Takeaways

- `/release` bumps, merges through a PR, tags, and publishes a forge release with generated notes.
- Release notes come from the forge (merged PR titles); the workspace writes none.
- The optional leak audit (`release.leakPatterns`) scans the publish surface — npm workspace packages and `release.consumerFacing` paths included — before the tag is pushed; matches stop for a human decision. An advisory consumer-facing review reads changed README and CHANGELOG prose for internal detail the patterns cannot name.
- Repos with their own release tooling ignore `/release` entirely.
- Versions are assigned at release time based on what shipped, not pre-planned.
