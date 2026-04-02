---
name: start-work
description: Begin a work session. Use at the start of any work — either resuming from a handoff or starting fresh. Accepts optional parameter "handoff" or "blank".
---

# Start Work

Begin a work session by resuming from shared context or starting fresh. Creates branches in both the project repo (with worktree) and the workspace repo for traceability.

## Parameters
- `/start-work handoff` — resume from an existing handoff
- `/start-work blank` — start new work from scratch
- `/start-work` (no param) — smart default: check for active context first

## Flow: No Parameter

1. Check `shared-context/` for ephemeral `.md` files (scan to depth 3, exclude `locked/`, `local-only-*`, `.keep`)
2. If active entries exist: "Found {N} active context items. Resume one, or start fresh?"
   - List entries with topic, lifecycle status, last updated, first line of Status section
   - Group by: inflight (current work sessions) vs ongoing (persistent context)
   - Wait for user choice
3. If no entries: proceed as `blank`

## Flow: Handoff

1. List all ephemeral shared-context entries with:
   - Topic name
   - Lifecycle status (active/paused)
   - Last updated timestamp
   - Author (if user-scoped)
   - Branch reference (if present)
   - Location: inflight/ vs ongoing
2. User selects one or more entries to resume
3. Read selected entries fully into context
4. If a selected entry has a `branch` field:
   - Check if the worktree exists at `repos/{repo}___wt-{branch-slug}/`
   - If yes: confirm it's checked out to the right branch
   - If no: offer to create the worktree from the existing branch
   - Check if a workspace branch with the same name exists, switch to it if so
5. Summarize loaded state: "Resuming {topic}. Branch: {branch}. Last session: {status summary}. Next: {next steps}."
6. Mark resumed entries as `lifecycle: active` if they were `paused`

## Flow: Blank

1. Ask: "What are you working on?"
2. Wait for response. Determine if this is a feature, bugfix, or chore.
3. Ask which repo this work targets (if multiple repos in workspace.json)
4. Propose branch name following git-conventions rule:
   - "How about `{prefix}/{suggested-slug}`? Or would you prefer something different?"
5. Wait for confirmation or adjustment

### Create branches in both repos

**Project repo** — branch + worktree:
```bash
cd repos/{repo}
git fetch origin
git checkout -b {branch-name} origin/{default-branch}
```
```bash
cd repos/
git -C {repo} worktree add ../{repo}___wt-{branch-slug} {branch-name}
```

**Workspace repo** — branch (same name for traceability):
```bash
# From workspace root
git checkout -b {branch-name}
```

6. Create `shared-context/{user}/inflight/` directory if it doesn't exist
7. Confirm: "Work session started. Worktree at repos/{repo}___wt-{branch-slug}/. Workspace on branch {branch-name}."

### Stale worktree check

Before creating a new worktree, scan for existing worktrees:
```bash
git -C repos/{repo} worktree list
```
If stale worktrees exist (no recent commits, no open PR):
- "You have {N} existing worktrees. `___wt-{old-branch}` has no commits in {days} days. Clean up? [y/N]"
- If yes: remove worktree and delete local branch
- If no: proceed with new worktree

### Next steps

8. If superpowers-workflow rule is active: run mandatory research phase, then invoke brainstorming skill
9. If not: ask "Ready to start implementing, or want to brainstorm first?"

## Flow: Retroactive (called mid-session)

When /start-work is called after work has already begun (files changed, commits made):

1. Detect what's already happened:
   - Check for uncommitted changes in repos/
   - Check for recent commits on non-default branches
   - Check for shared-context files created this session
2. "It looks like you've already been working. Let me formalize this."
3. If changes are on a default branch:
   - Offer to create a branch retroactively: stash → create branch → pop stash
4. If changes are already on a feature branch:
   - Create the workspace branch to match
   - Create inflight/ directory
5. Link existing session braindumps/handoffs to the work session
6. Summarize: "Formalized as work session: {branch-name}. {N} files changed, {M} context files linked."

## Notes
- Both repos get the same branch name for traceability
- The workspace repo doesn't get a worktree — it stays as the working directory with a branch checkout
- inflight/ is created per work session, consumed by /complete-work
- Stale worktree detection prevents accumulation of forgotten worktrees
