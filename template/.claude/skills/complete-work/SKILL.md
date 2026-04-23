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

3. **Handoffs** — any shared-context entries referencing this branch:
   ```bash
   grep -rl "branch: {branch}" shared-context/
   ```
   Read each matching file.

4. **Branch commit logs** (per repo):
   ```bash
   # For each repo in the tracker's repos list:
   cd work-sessions/{session-name}/workspace/repos/{repo}
   git log origin/{repo-branch}..HEAD --oneline
   ```

### Step 6: Synthesize release notes

For each repo in the tracker's `repos:` list that has commits beyond the base branch:

```bash
cd work-sessions/{session-name}/workspace/repos/{repo}
COMMIT_ID=$(git rev-parse --short HEAD)
mkdir -p release-notes/unreleased
```

**File 1: `release-notes/unreleased/branch-release-notes-{COMMIT_ID}.md`**
```markdown
---
branch: {branch}
type: {feature|fix|chore}
author: {user}
date: {YYYY-MM-DD}
---

## {Human-readable title}

{Coherent narrative synthesized from tracker + spec + plan + commits.
Written from scratch per coherent-revisions rule.}
```

**File 2: `release-notes/unreleased/branch-release-questions-{COMMIT_ID}.md`**
```markdown
---
branch: {branch}
author: {user}
date: {YYYY-MM-DD}
---

## Open Questions

{Only genuinely open questions — not things resolved during implementation.}
```

Commit per repo:
```bash
git add release-notes/unreleased/
git commit -m "docs: add release notes for {branch}"
```

If a repo has no commits beyond the base, skip release notes for it.

### Step 7: Consume session-scoped sources

The entire `work-sessions/{session-name}/` folder is removed by the cleanup script in Step 12. Before that happens, make sure everything worth preserving has landed in release notes.

No separate "consume spec and plan" commit is needed for the project repos — specs and plans now live in the session folder, not in the project worktrees. The project worktrees only carry source code changes.

### Step 7c: Remove session artifacts from the workspace branch

Session content (tracker, specs, plans) lives at the top of the workspace worktree on the session branch. Its purpose was synthesis into release notes in Step 6 — that work is now done. Remove the files from the branch before the final push so main's top level stays free of session artifacts:

```bash
cd work-sessions/{session-name}/workspace
git rm -f session.md 2>/dev/null || true
git rm -f design-*.md 2>/dev/null || true
git rm -f plan-*.md 2>/dev/null || true
git commit -m "chore: remove session artifacts before PR" 2>/dev/null || true
```

The `|| true` guards keep this idempotent — if a file is already gone (e.g., a session without specs), the step is a no-op. The commit is skipped when there's nothing staged.

This commit persists in the branch's history. On squash merge or rebase merge, branch history collapses to one clean commit on main with no session artifacts. On merge commits, branch history is reachable but the final tree on main shows no session content.

### Step 7b: Version bump (if applicable)

For each repo in the tracker's `repos:`, check if the repo has versioning:
```bash
cd work-sessions/{session-name}/workspace/repos/{repo}
cat package.json 2>/dev/null | grep '"version"'
```

If no `package.json` or no `version` field: skip this repo — no versioning to manage.

If the repo has a version, determine the appropriate bump from the release notes just written:

1. Read the `type:` field from the branch release notes created in Step 6
2. Determine the bump:
   - `type: fix` or `type: chore` → **patch** (auto-bump, no confirmation needed)
   - `type: feature` → **minor** (present to user: "This session adds new functionality. Suggested bump: {current} → {next-minor}. Confirm or adjust?")
   - Breaking changes detected (schema changes, removed APIs, convention changes) → **major** (present to user: "This session includes breaking changes. Suggested bump: {current} → {next-major}. Confirm or adjust?")

3. Apply the bump:
   ```bash
   git add package.json
   git commit -m "chore: bump version to {new-version}"
   ```

The user can override any suggestion. Accept their decision.

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
- **Hand off to someone** — create a team-visible handoff at root shared-context/ for another member to pick up
- **Revert** — undo the changes (with confirmation)

## Notes
- Release notes live in the PROJECT repo worktrees — never the workspace
- The session tracker's body is the primary source for release note synthesis — it captures the full session history alongside specs and plans
- All repos get PRed and merged together — one approval for all
- The teardown order is mandatory: project worktrees first, then workspace worktree, then prune, then delete the session folder
- Context consumption, cleanup, and auto-committing release notes are intentional workflow behavior — these bypass normal commit conventions by design
