---
name: complete-work
description: Finalize a work session — rebase, synthesize release notes from specs/plans/tracker/commits, create PRs with unified presentation. Handles both project repo and workspace repo. Use when work on a session is done.
---

# Complete Work

Finalize the active work session. Handles both the project repo (code changes, release notes, PR) and the workspace repo (context processing, PR). Presents a unified summary with a single merge approval.

## Flow

### Step 1: Detect context

Read the active-session pointer from `.claude-scratchpad/.active-session.json`.
If no active session: "No active work session. Nothing to complete."

Read the full session marker from the main root's `.claude-scratchpad/`.

Determine paths:
- Workspace worktree: `repos/{session-name}___wt-workspace/`
- Project worktree: `repos/{session-name}___wt-{repo}/`
- Read the repo's branch from workspace.json (`repos.{repo}.branch`)

### Step 2: Rebase project repo

```bash
# {repo-branch} = repos.{repo}.branch from workspace.json
cd repos/{session-name}___wt-{repo}
git fetch origin
git rebase origin/{repo-branch}
```
If conflicts arise, STOP and present them to the user. Do not auto-resolve.

### Step 3: Capture final discussion state

Run `/braindump` to capture any final discussion/reasoning to the inflight tracker.
If the user declines or there's nothing to capture, skip.

### Step 4: Gather source material

Formally read ALL sources before synthesizing — do not write release notes from memory alone:

1. **Inflight tracker** at `shared-context/{user}/inflight/session-{session-name}.md`

2. **Branch-scoped specs/plans** in the project worktree or inflight/:
   - `design-*.md` files
   - `plan-*.md` files
   - Read each one fully

3. **Handoffs** — any shared-context entries referencing this branch:
   ```bash
   grep -rl "branch: {branch}" shared-context/
   ```
   Read each matching file.

4. **Branch commit log:**
   ```bash
   git log origin/{repo-branch}..HEAD --oneline
   ```

### Step 5: Synthesize release notes

Using the gathered material, create two files in the **project repo** worktree:

```bash
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

Commit to the project repo worktree:
```bash
git add release-notes/unreleased/
git commit -m "docs: add release notes for {branch}"
```

### Step 6: Consume branch-scoped sources

Remove branch-scoped specs and plans from the project worktree:
```bash
cd repos/{session-name}___wt-{repo}
rm -f design-*.md plan-*.md
git add -u && git commit -m "chore: remove consumed branch-scoped specs and plans"
```

Only consume files that are branch-scoped (in the worktree or inflight/). Leave project-scoped specs in `{user}/` ongoing.

### Step 7: Check for no-remote

Before pushing, verify remotes exist for both repos:
```bash
git remote -v
```
If no remote: "No remote configured for {repo}. Want me to create one on GitHub, or provide a URL?"
Create via `gh repo create` or add the provided URL. Never silently skip push.

### Step 8: Push both repos

```bash
# Project repo
cd repos/{session-name}___wt-{repo}
git push -u origin {branch}

# Workspace repo
cd repos/{session-name}___wt-workspace
git add shared-context/
git commit -m "chore: finalize context for {session-name}"
git push -u origin {branch}
```

### Step 9: Create PRs and present unified summary

Create both PRs, then present a single unified summary:

```bash
# Project PR
cd repos/{session-name}___wt-{repo}
gh pr create --title "{type}: {description}" --body "..."

# Workspace PR
cd repos/{session-name}___wt-workspace
gh pr create --title "context: {session-name} work session" --body "..."
```

Present unified summary:
```
Work session complete:

PROJECT: {repo}
  PR #{n}: {type}: {description}
  Branch: {branch} → {repo-branch}
  Changes:
    - {bullet points from release notes}
  Release notes: branch-release-notes-{COMMIT_ID}.md

WORKSPACE: {workspace-name}
  PR #{m}: context: {session-name} work session
  Branch: {branch} → main
  Changes:
    - {summary of shared-context changes}

Merge both? [Y/n]
```

If yes:
```bash
gh pr merge {project-pr-number} --merge
gh pr merge {workspace-pr-number} --merge

# Pull both repos to their default branches
cd repos/{repo} && git pull origin {repo-branch}
cd {main-workspace-root} && git pull origin main
```

### Step 10: Cleanup

Run the cleanup helper script from the main workspace root:
```bash
node .claude/scripts/cleanup-work-session.mjs --session-name "{session-name}"
```

This removes:
- Workspace worktree
- Project worktree
- Local branches in both repos
- Session marker

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
- Release notes live in the PROJECT repo worktree — never the workspace
- The inflight tracker is the primary source for release note synthesis — it captures the full session history
- Both repos get PRed and merged together — one approval for both
- Context consumption, cleanup, and auto-committing release notes are intentional workflow behavior — these bypass normal commit conventions by design
