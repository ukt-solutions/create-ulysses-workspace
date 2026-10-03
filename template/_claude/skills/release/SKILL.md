---
name: release
description: Cut a versioned release of one project repo — bump the version, merge it through a PR, tag it, and publish a forge release whose notes are generated from merged PRs. No release-notes files.
---

# Release

Cut a versioned release of one project repo. The version bump travels through a PR like any other change; the tag marks the merge commit; the forge generates the release notes from merged PR titles. The workspace keeps no release-notes files of its own.

## Why this shape

Release notes come from the forge. GitHub's generated notes (merged PR titles) are what users of a published release actually read; the detail behind each PR already lives in the issue and the PR body, so duplicating it into workspace files buys nothing. Projects that use changesets, semantic-release, or their own release tooling simply don't use this skill. A repo's `CHANGELOG.md`, if it has one, is historical — this skill never writes it.

## Parameters

- `/release {version}` — release a specific version
- `/release` — ask for the version

## Flow

**Step 1: Determine version and repo**

Ask which repo to release — read `repos` from `workspace.json` and default to the entry with `"primary": true`. If no version was given, ask the bump kind (patch/minor/major) after showing the merged PRs since the last tag, so the operator can judge the impact:

```bash
git -C repos/{repo} describe --tags --abbrev=0        # v{previous}
git -C repos/{repo} log -1 --format=%cI v{previous}   # the previous tag's commit time
```

Then call the forge adapter's `prList` with `state: 'merged'`, `base:` the repo's default branch, and a merged-after search bounded by that tag's commit time — the full `%cI` timestamp (e.g. `merged:>2026-05-01T10:00:00Z`), never a bare date, which would sweep in every PR merged later the same day. `base` matters because PRs merged into other branches are not this release. If the returned list carries `truncated: true`, older PRs may sit beyond the fetched page — say so and re-query with a higher `limit` before judging the bump. Pre-v1.0 breaking changes are a minor bump.

**Step 2: Preflight the tag and the forge**

Two checks before anything is pushed. First the tag: if `v{version}` already exists on origin, stop and ask — reuse it, investigate with `forge.releaseView`, or pick another version. Never force-push a tag.

```bash
git -C repos/{repo} ls-remote --exit-code origin refs/tags/v{version}
```

Second the release path. Build the repo's forge with `forgeConfigForRepo(root, '{repo}', ws)` from `.claude/scripts/merge-mode.mjs` — it picks the adapter from the repo's own origin, so a GitLab repo gets the gitlab adapter whatever `workspace.forge` says — and decide now who creates the release (Step 6): the repo's CI, or this skill. If the flow needs something the forge cannot do, stop here — past this point the tag is pushed, and a publish that cannot run is much harder to unwind.

**Step 3: Bump on a branch**

Create a task worktree for the release branch:

```bash
node .claude/scripts/task-worktree.mjs --root . --create --repo "{repo}" --branch "release/v{version}"
```

If the repo has a `package.json` with a `version`, set it to `{version}` (edit the JSON; keep formatting) and update `package-lock.json`'s top-level version fields if that file is present. Commit `chore: release v{version}`. If the repo has no version file, skip the commit — step 6 tags the current default-branch head instead.

**Step 4: Merge**

Push the branch and open a PR through the same per-repo forge (`forgeConfigForRepo` from Step 2) with head `release/v{version}`. Ask `Merge? [Y/n]`, then merge (squash, delete branch).

**Step 5: Leak audit (optional)**

Pull the merge, then — only where leak patterns are configured — audit what is about to be tagged:

```bash
git -C repos/{repo} pull --ff-only
node .claude/scripts/release-leak-audit.mjs --root . --repo "{repo}"
```

Patterns live in `workspace.json` — `repos.{repo}.release.leakPatterns` for one repo, `workspace.release.leakPatterns` for every repo — as arrays of strings: `/…/flags` is that regex, anything else a case-insensitive literal. The script scans only what this release publishes: the `npm pack --dry-run` file list when the repo's `package.json` is not `"private": true`, otherwise the files changed since the last tag (`--tag-range <from>..<to>` overrides), plus the release's commit subjects. With no patterns configured it exits 0 having scanned nothing — the step does not exist for workspaces that never opt in.

Exit 1 lists matches as `{ file, line, pattern, excerpt }`: stop and show them; never edit files to silence the audit. Whether a match is a true leak, an over-broad pattern, or a release to redo is the operator's call — cheap before the tag is pushed, impossible after. Exit 2 means the audit itself could not run; report that too.

**Step 6: Tag and publish**

Tag the merge and push the tag:

```bash
git -C repos/{repo} tag v{version}
git -C repos/{repo} push origin v{version}
```

Who creates the release depends on the repo, and the CI check is per-forge:

- **GitHub**: `.github/workflows/publish.yml` that itself creates the release (it contains `gh release create`, `softprops/action-gh-release`, or `actions/create-release`) owns the release — do not call `releaseCreate`; racing it duplicates the release or fails. Instead find and watch its run with `workflowRunFind` / `workflowRunWatch` — retry the find up to 5 times with 3 s backoff (the run may not be registered the moment the tag lands); a failed run is reported to the operator, not thrown.
- **GitLab**: `.gitlab-ci.yml` with a `release:` keyword block (a release-cli job) owns the release the same way — do not call `releaseCreate`; find and watch the tag's pipeline with `workflowRunFind({ workflow: 'ci.yml', branch: 'v{version}' })` / `workflowRunWatch` (the workflow name is ignored — one pipeline per ref).

Either way, confirm the release exists with `forge.releaseView({ tag: 'v{version}', repo })`.

Otherwise the skill creates the release itself — on GitHub the forge generates the notes; on GitLab it cannot (`NOT_SUPPORTED`), so the notes come from the same query Step 1 ran:

```js
// GitHub
await forge.releaseCreate({ tag: 'v{version}', repo, generateNotes: true });
// GitLab — notes come from the skill, not the forge. tagTime is the %cI of
// v{previous}; base excludes MRs merged into other branches.
const merged = await forge.prList({ state: 'merged', base: '{default branch}',
  search: `merged:>${tagTime}`, repo });
if (merged.truncated) warn('older MRs may be missing — raise limit and re-query');
await forge.releaseCreate({ tag: 'v{version}', repo, generateNotes: false,
  notes: merged.map((p) => `- ${p.title}`).join('\n') });
```

If a `publish.yml` (or a publish job) without release creation exists, still find and watch its run the same way.

**Step 7: Tear down and report**

Remove the release worktree:

```bash
node .claude/scripts/task-worktree.mjs --root . --remove --repo "{repo}" --branch "release/v{version}" --delete-branch
```

Report the PR, the tag, the release URL, and the publish status.

**Step 8: Update workspace release state**

If the workspace keeps release state in `workspace-context/` (for example a current-release line in a status file under `shared/locked/`), offer to update it — through a workspace task worktree and PR, never on the launcher.

## Notes

- Never run `npm publish` locally. The publish workflow is the only path that exercises OIDC trusted publishing; a local publish requires a 2FA OTP and bypasses it. If the workflow fails, investigate via `gh run view` — do not fall back to a local publish.
- Recovery from a failed publish: transient failures rerun via `gh run rerun {run_id}`; content failures mean deleting the tag and redoing the release. Once a version is published to a registry, that version number is committed — bump and release a new version instead.
- Pre-v1.0 breaking changes are a minor bump, not major.
