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
git -C repos/{repo} describe --tags --abbrev=0
```

Then call the forge adapter's `prList` with a merged-after search bounded by that tag's date (e.g. `merged:>{date}`). Pre-v1.0 breaking changes are a minor bump.

**Step 2: Preflight the tag**

If `v{version}` already exists on origin, stop and ask — reuse it, investigate with `forge.releaseView`, or pick another version. Never force-push a tag.

```bash
git -C repos/{repo} ls-remote --exit-code origin refs/tags/v{version}
```

**Step 3: Bump on a branch**

Create a task worktree for the release branch:

```bash
node .claude/scripts/task-worktree.mjs --root . --create --repo "{repo}" --branch "release/v{version}"
```

If the repo has a `package.json` with a `version`, set it to `{version}` (edit the JSON; keep formatting) and update `package-lock.json`'s top-level version fields if that file is present. Commit `chore: release v{version}`. If the repo has no version file, skip the commit — step 5 tags the current default-branch head instead.

**Step 4: Merge**

Push the branch and open a PR through the forge adapter — per-repo `createForge({ ...ws.workspace?.forge, repo: '{owner}/{name}' })` with head `release/v{version}`. Ask `Merge? [Y/n]`, then merge (squash, delete branch).

**Step 5: Tag and publish**

Pull the merge, tag it, push the tag, and publish the forge release:

```bash
git -C repos/{repo} pull --ff-only
git -C repos/{repo} tag v{version}
git -C repos/{repo} push origin v{version}
```

```js
await forge.releaseCreate({ tag: 'v{version}', repo, generateNotes: true });
```

If the repo has `.github/workflows/publish.yml`, find and watch its run with `workflowRunFind` / `workflowRunWatch` — retry the find up to 5 times with 3 s backoff (the run may not be registered the moment the tag lands). A failed run is reported to the operator, not thrown.

**Step 6: Tear down and report**

Remove the release worktree:

```bash
node .claude/scripts/task-worktree.mjs --root . --remove --repo "{repo}" --branch "release/v{version}" --delete-branch
```

Report the PR, the tag, the release URL, and the publish status.

**Step 7: Update workspace release state**

If the workspace keeps release state in `workspace-context/` (for example a current-release line in a status file under `shared/locked/`), offer to update it — through a workspace task worktree and PR, never on the launcher.

## Notes

- Never run `npm publish` locally. The publish workflow is the only path that exercises OIDC trusted publishing; a local publish requires a 2FA OTP and bypasses it. If the workflow fails, investigate via `gh run view` — do not fall back to a local publish.
- Recovery from a failed publish: transient failures rerun via `gh run rerun {run_id}`; content failures mean deleting the tag and redoing the release. Once a version is published to a registry, that version number is committed — bump and release a new version instead.
- Pre-v1.0 breaking changes are a minor bump, not major.
