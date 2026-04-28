---
name: complete-work
description: Finalize a work session — rebase, synthesize release notes from spec/plan/session tracker/commits, create PRs with unified presentation. Handles all project repos and workspace repo. Use when work on a session is done.
---

# Complete Work

Finalize the active work session. Handles all project repos (code changes, release notes, PRs) and the workspace repo (context processing, PR). Presents a unified summary with a single merge approval, then tears down the session folder.

## Flow

### Step 1: Detect context

Read the active-session pointer from `.claude/.active-session.json` in the current worktree.
If no active session: "No active work session. Nothing to complete."

Read the full session tracker at `work-sessions/{session-name}/workspace/session.md` (use the frontmatter helper in `.claude/lib/session-frontmatter.mjs` — scripts and hooks use `_utils.mjs` which wraps it).

Determine paths:
- Session folder: `work-sessions/{session-name}/`
- Workspace worktree: `work-sessions/{session-name}/workspace/`
- Project worktrees: `work-sessions/{session-name}/workspace/repos/{repo}/` for each repo in the tracker's `repos:` list
- Read each repo's default branch from workspace.json (`repos.{repo}.branch`)

### Step 2: Rebase project repos

For each repo in the tracker's `repos:`:
```bash
# {repo-branch} = repos.{repo}.branch from workspace.json
cd work-sessions/{session-name}/workspace/repos/{repo}
git fetch origin
git rebase origin/{repo-branch}
```
If conflicts arise in any repo, STOP and present them to the user. Do not auto-resolve.

### Step 3: Capture final discussion state

Run `/braindump` to capture any final discussion/reasoning to the session tracker body.
If the user declines or there's nothing to capture, skip.

### Step 4: Flush task list to session.md

Before reading sources for synthesis, flush current `TodoWrite` state to `## Tasks` per the `task-list-mirroring` rule. This ensures the synthesis in Step 6 sees the final state:

```bash
cd work-sessions/{session-name}/workspace
echo '<JSON-of-current-todos>' | node .claude/scripts/sync-tasks.mjs --write session.md
```

Mark `Complete work` as `in_progress` in the JSON before flushing — the rest of this skill IS the act of completing.

### Step 5: Gather source material

Formally read ALL sources before synthesizing — do not write release notes from memory alone:

1. **Session tracker** at `work-sessions/{session-name}/workspace/session.md` — read the full body (frontmatter is machine state, body is human content)

2. **Session-scoped specs/plans** at the top of the session worktree:
   - `work-sessions/{session-name}/workspace/design-*.md` files
   - `work-sessions/{session-name}/workspace/plan-*.md` files
   - Read each one fully

3. **Handoffs** — any workspace-context entries referencing this branch:
   ```bash
   grep -rl "branch: {branch}" workspace-context/
   ```
   Read each matching file.

4. **Branch commit logs** (per repo):
   ```bash
   # For each repo in the tracker's repos list:
   cd work-sessions/{session-name}/workspace/repos/{repo}
   git log origin/{repo-branch}..HEAD --oneline
   ```

### Step 6: Synthesize release notes

Branch notes are written to the **workspace** repo, not the project repo. They are an internal retrospection artifact consumed by `/release` at release time; the project repo only ever receives a `CHANGELOG.md` entry. This separation keeps dogfood content out of public project repos between feature merge and the next release cut.

For each repo in the tracker's `repos:` list that has commits beyond the base branch:

```bash
cd work-sessions/{session-name}/workspace/repos/{repo}
COMMIT_ID=$(git rev-parse --short HEAD)
cd ../..  # back to the workspace worktree
mkdir -p release-notes/unreleased/{repo-name}
```

**File 1: `release-notes/unreleased/{repo-name}/branch-release-notes-{COMMIT_ID}.md`** (relative to the workspace worktree)
```markdown
---
branch: {branch}
repo: {repo-name}
type: {feature|fix|chore}
author: {user}
date: {YYYY-MM-DD}
---

## {Human-readable title}

{Coherent narrative synthesized from tracker + spec + plan + commits.
Written from scratch per coherent-revisions rule.}
```

**File 2: `release-notes/unreleased/{repo-name}/branch-release-questions-{COMMIT_ID}.md`**
```markdown
---
branch: {branch}
repo: {repo-name}
author: {user}
date: {YYYY-MM-DD}
---

## Open Questions

{Only genuinely open questions — not things resolved during implementation.}
```

The `repo:` frontmatter field is what `/release` uses to know which project repo's `CHANGELOG.md` should consume each note. The directory name is the same as the field for redundancy.

After all repos are processed, commit once on the workspace branch:
```bash
cd work-sessions/{session-name}/workspace
git add release-notes/unreleased/
git commit -m "docs: add release notes for {branch}"
```

If a repo has no commits beyond the base, skip release notes for it.

### Step 7: Remove session artifacts from the workspace branch

The entire `work-sessions/{session-name}/` folder is removed by the cleanup script in Step 12. Before that happens, make sure everything worth preserving has landed in release notes (Step 6) — once Step 6 has run, the tracker, specs, and plans have served their purpose.

Session content lives at the top of the workspace worktree on the session branch. Remove these files from the branch before the final push so main's top level stays free of session artifacts:

```bash
cd work-sessions/{session-name}/workspace
git rm -f session.md 2>/dev/null || true
git rm -f design-*.md 2>/dev/null || true
git rm -f plan-*.md 2>/dev/null || true
git commit -m "chore: remove session artifacts before PR" 2>/dev/null || true
```

The `|| true` guards keep this idempotent — if a file is already gone (e.g., a session without specs), the step is a no-op. The commit is skipped when there's nothing staged.

This commit persists in the branch's history. On squash merge or rebase merge, branch history collapses to one clean commit on main with no session artifacts. On merge commits, branch history is reachable but the final tree on main shows no session content.

> **No version bump here.** Versions are bumped at release time by `/release`, which consumes accumulated unreleased branch notes into a single `CHANGELOG.md` entry per project repo. `/complete-work` only writes branch notes; it does not modify any project repo's `package.json`. This avoids version drift when multiple feature branches land between releases.

### Step 8: Detect remote type per repo

For each repo in the tracker's `repos:` plus the workspace repo, determine the remote type. This drives how Step 9 and Step 10 push and merge.

```bash
cd work-sessions/{session-name}/workspace/repos/{repo}
git remote get-url origin 2>&1
```

Classify the result:

- **GitHub remote** — URL contains `github.com` or `gh repo view` succeeds against origin → use the PR flow (Step 9a, Step 10a).
- **Local / bare remote** — URL is a filesystem path (starts with `/`, `./`, `file://`, or points at a `.git` bare mirror) → use the local merge flow (Step 9b, Step 10b).
- **Other remote** (e.g., GitLab, Bitbucket, self-hosted) — no `gh` support → fall back to the local merge flow (Step 9b, Step 10b), and mention it in the final summary.
- **No remote at all** — "No remote configured for {repo}. Want me to create one on GitHub, add an existing URL, or keep the session local (push/merge inside the local clone only)?" Act on the user's choice. Never silently skip push.

### Step 9: Push all repos

#### Step 9a: GitHub remotes

```bash
# Each project repo with a GitHub remote
cd work-sessions/{session-name}/workspace/repos/{repo}
git push -u origin {branch}

# Workspace repo — from the workspace worktree
cd work-sessions/{session-name}/workspace
git add .
git commit -m "chore: finalize context for {session-name}"
git push -u origin {branch}
```

#### Step 9b: Local/bare remotes

```bash
# Push the feature branch to the bare remote so it exists there
cd work-sessions/{session-name}/workspace/repos/{repo}
git push -u origin {branch}

# Workspace repo — same commit + push pattern
cd work-sessions/{session-name}/workspace
git add .
git commit -m "chore: finalize context for {session-name}"
git push -u origin {branch}
```

The push shape is the same as 9a — what differs is the merge mechanics in Step 10b.

### Step 10: Merge and present unified summary

#### Step 10a: GitHub remotes — create PRs, unified summary, merge

Create one PR per project repo plus one workspace PR:

```bash
# For each repo in the tracker's repos with a GitHub remote:
cd work-sessions/{session-name}/workspace/repos/{repo}
gh pr create --title "{type}: {description}" --body "..."

# Workspace PR — from the workspace worktree
cd work-sessions/{session-name}/workspace
gh pr create --title "context: {session-name} work session" --body "..."
```

Present unified summary:
```
Work session complete:

PROJECT: {repo-1}
  PR #{n}: {type}: {description}
  Branch: {branch} → {repo-1-branch}
  Changes:
    - {bullet points from release notes}
  Release notes: branch-release-notes-{COMMIT_ID}.md

PROJECT: {repo-2}
  PR #{m}: {type}: {description}
  Branch: {branch} → {repo-2-branch}
  Changes:
    - {bullet points from release notes}

WORKSPACE: {workspace-name}
  PR #{p}: context: {session-name} work session
  Branch: {branch} → main

Merge all? [Y/n]
```

If yes — merge all PRs atomically:
```bash
# For each project PR:
gh pr merge {pr-number} --merge

# Workspace PR:
gh pr merge {workspace-pr-number} --merge

# Pull all repos to their default branches
# For each repo in the tracker's repos:
cd repos/{repo} && git pull origin {repo-branch}
cd {main-workspace-root} && git pull origin main
```

**Step 10a.1: Tag the merge commit (release sessions only, project repos with `package.json`)**

The next three sub-substeps run only when the session branch starts with `release/` — the convention for release sessions (e.g., `release/v0.15.0-beta.0`). For feature, bugfix, and chore sessions, skip 10a.1, 10a.2, and 10a.3 entirely; non-release sessions don't trigger publishes. Detection is purely by branch prefix.

Derive the version tag from the branch name by stripping the `release/` prefix (so `release/v0.15.0-beta.0` yields `v0.15.0-beta.0`). For each project repo whose `package.json` declares a `version` field, verify that version matches the derived tag. The workspace repo is **never** tagged — only project repos with publishable `package.json` files get tagged, since the tag triggers `.github/workflows/publish.yml` in that project repo. If a project repo's `package.json` version doesn't match the release tag, skip that repo with a warning rather than failing the whole completion flow — the mismatch usually means `/release` was run against a different version than the branch name suggests, and the user needs to investigate before publishing.

Before tagging, preflight against origin: if `v{version}` already exists remotely, surface the conflict to the user with three explicit recovery options — **Reuse** (skip to 10a.2 if the existing tag points at the right commit), **Replace** (`git push origin --delete v{version}` then re-run 10a.1), or **Investigate** (`gh release view v{version}` to see what shipped). Do **not** silently force-push the tag; an existing tag means a published artifact, and overwriting it without confirmation can corrupt the npm registry's view of the release history.

If the tag is absent on origin, tag the merge commit (HEAD on `{default-branch}` after the prior `git pull origin {default-branch}`) and push the tag. The tag push triggers `.github/workflows/publish.yml`.

```bash
# Detect: only run for release sessions.
if [[ ! "$branch" =~ ^release/ ]]; then
  # Not a release session — skip 10a.1, 10a.2, 10a.3.
  return
fi

# Extract the version from the branch name (release/v{X} → v{X}).
version_tag="${branch#release/}"   # e.g. "v0.15.0-beta.0"

# For each project repo with a package.json containing a version field:
for repo in {project-repos-with-package-json}; do
  cd repos/{repo}

  # Verify package.json version matches the tag.
  pkg_version=$(node -p "require('./package.json').version")
  expected_version="${version_tag#v}"
  if [ "$pkg_version" != "$expected_version" ]; then
    echo "Skipping {repo}: package.json version ($pkg_version) does not match release tag ($expected_version)."
    continue
  fi

  # Preflight: does the tag already exist on origin?
  if git ls-remote --exit-code origin "refs/tags/$version_tag" >/dev/null 2>&1; then
    # Tag exists. Surface to user with three options:
    # 1. Reuse — skip to 10a.2 if the existing tag points at the right commit.
    # 2. Replace — `git push origin --delete $version_tag` then re-run 10a.1.
    # 3. Investigate — `gh release view $version_tag` to see what shipped.
    # Do NOT silently force-push.
    echo "Tag $version_tag already exists on origin. Aborting with recovery options."
    return 1
  fi

  # Tag the merge commit (HEAD on default branch after the prior `git pull`).
  git tag "$version_tag"
  git push origin "$version_tag"   # Triggers .github/workflows/publish.yml
done
```

**Step 10a.2: Watch the publish workflow (release sessions only)**

For each project repo tagged in 10a.1, find and follow the `publish.yml` workflow run on GitHub. The workflow takes a moment to register against the new tag — poll `gh run list` up to 5 times with a 3-second backoff before giving up. Once the run is found, attach with `gh run watch` so the maintainer sees progress live alongside the unified summary. Append `|| true` to the watch command so a workflow failure does **not** abort the rest of `/complete-work`: the maintainer still needs to see the unified summary, including the failure URL, to decide whether to rerun, redo the release, or roll the tag back. If no run registers within the retry window, log a warning with the manual investigation command and continue.

```bash
# Retry up to 5 times with 3-second backoff — the run takes a moment to register.
for i in 1 2 3 4 5; do
  run_id=$(gh run list \
    --repo {org}/{repo} \
    --workflow publish.yml \
    --branch "$version_tag" \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId')
  if [ -n "$run_id" ]; then break; fi
  sleep 3
done

if [ -z "$run_id" ]; then
  echo "Warning: no publish workflow run found for $version_tag after 15s. Investigate via 'gh run list'."
else
  gh run watch "$run_id" --exit-status --repo {org}/{repo} || true
fi
```

**Step 10a.3: Update the unified summary (release sessions only)**

The unified summary block presented earlier in Step 10a already has a section per project repo. For release sessions, append a `PUBLISH` section per tagged project repo to the same summary — this goes inside the existing summary, not in a new location, so the maintainer sees one consolidated report covering merges, tags, and npm publishes:

```
PUBLISH ({repo}):
  Tag: v{version}
  Workflow: {run-url}
  Status: success | failure
  Published: {dist-tag}@{version} on npm
```

Pull `Status` from the `gh run watch` exit code (success when the watch returned 0, failure otherwise). Pull `Published: {dist-tag}@{version}` from the workflow's published-package output if available; if the workflow failed before publishing, omit the `Published:` line and rely on `Status: failure` plus the workflow URL to point the maintainer at the failure.

#### Step 10b: Local / bare / other remotes — local merge flow

No PRs are created — these remotes don't have a PR concept (or we don't have a client wired up for them). Present an adjusted summary:

```
Work session complete:

PROJECT: {repo-1}  (local remote)
  Branch: {branch} → {repo-1-branch}
  Changes:
    - {bullet points from release notes}
  Release notes: branch-release-notes-{COMMIT_ID}.md

PROJECT: {repo-2}  (local remote)
  Branch: {branch} → {repo-2-branch}
  Changes:
    - {bullet points from release notes}

WORKSPACE: {workspace-name}  (local remote)
  Branch: {branch} → main

Merge all locally? [Y/n]
```

If yes — fast-forward merge on each remote, delete the feature branch, pull the source clone:
```bash
# For each repo in the tracker's repos with a local/bare remote:
cd work-sessions/{session-name}/workspace/repos/{repo}
git push origin HEAD:{repo-branch}        # fast-forward the default branch
git push origin --delete {branch}         # remove the feature branch from the remote
cd repos/{repo} && git checkout {repo-branch} && git pull origin {repo-branch}

# Workspace repo — same pattern from the workspace worktree
cd work-sessions/{session-name}/workspace
git push origin HEAD:main
git push origin --delete {branch}
cd {main-workspace-root} && git pull origin main
```

If the fast-forward push fails because the remote's default branch has moved ahead, STOP and present the divergence — the user decides whether to rebase and retry or handle it another way. Do not auto-resolve.

For repos with no remote at all (user chose "keep local"): skip push entirely. The branch lives only in the source clone after cleanup merges it:
```bash
cd repos/{repo} && git merge --ff-only {branch}
```

### Step 11: Close the linked issue on the tracker

If the session tracker has a `workItem:` field AND `workspace.tracker` is configured, close the linked issue via the adapter after all PRs have merged:

```javascript
import { createTracker } from './.claude/scripts/trackers/interface.mjs';
import { readFileSync } from 'node:fs';
const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
if (ws.workspace?.tracker) {
  const tracker = createTracker(ws.workspace.tracker);
  const comment = [
    `**Completed by @${currentUser}**`,
    '',
    'Merged PRs:',
    ...mergedPrs.map(p => `- ${p.repo}: ${p.url}`),
    '',
    releaseSummary, // 1-3 sentence synthesis of what shipped, drawn from release notes
  ].join('\n');
  await tracker.closeIssue(workItem, { comment });
}
```

If `workItem:` is unset, skip the close — this was a blank session.

If the close call fails (tracker unreachable, auth expired), report the error in the unified summary but do not block Step 12 cleanup. The issue can be closed manually via the GitHub UI; no data is at risk.

### Step 12: Cleanup

Run the cleanup helper script from the main workspace root:
```bash
node .claude/scripts/cleanup-work-session.mjs --session-name "{session-name}"
```

The script tears down in the **mandatory** order:
1. Remove each nested project worktree from its project repo
2. Remove the workspace worktree from the workspace repo
3. `git worktree prune` on each project repo (belt-and-suspenders for orphan records)
4. Delete local branches in all repos
5. `rm -rf work-sessions/{session-name}/` — the tracker, specs, plans, and any local-only artifacts vanish. Their content was already archived into release notes in Step 6.

Workspace-first removal silently deletes the nested project worktrees' `.git` files and leaves orphan worktree records in the project repos. The script enforces the safe order.

Verify workspace root is still on main:
```bash
git branch --show-current  # should be "main"
```

## Handling Unformal Work Sessions

If /complete-work is called but changes were made without a formal work session (no branch, changes on default branch):

Ask: "These changes weren't part of a formal work session. What do you want to do?"
- **Accept as work** — create a session retroactively, proceed with normal completion
- **Stash for later** — create a user-scoped handoff describing what was done, stash the changes
- **Hand off to someone** — create a team-visible handoff at root workspace-context/ for another member to pick up
- **Revert** — undo the changes (with confirmation)

## Notes
- Branch release notes live in the WORKSPACE repo at `release-notes/unreleased/{repo-name}/` — never in project repos. Project repos only ever see code commits and (at release time) `CHANGELOG.md` entries written by `/release`.
- The session tracker's body is the primary source for release note synthesis — it captures the full session history alongside specs and plans
- All repos get PRed and merged together — one approval for all
- Version bumps happen in `/release`, not `/complete-work` — this avoids version drift when multiple feature branches land between releases
- The teardown order is mandatory: project worktrees first, then workspace worktree, then prune, then delete the session folder
- Context consumption, cleanup, and auto-committing release notes are intentional workflow behavior — these bypass normal commit conventions by design
