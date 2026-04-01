---
name: start-work
description: Begin a work session. Use at the start of any work — either resuming from a handoff or starting fresh. Accepts optional parameter "handoff" or "blank".
---

# Start Work

Begin a work session by resuming from shared context or starting fresh.

## Parameters
- `/start-work handoff` — resume from an existing handoff
- `/start-work blank` — start new work from scratch
- `/start-work` (no param) — smart default: check for active context first

## Flow: No Parameter

1. Check `shared-context/` for ephemeral `.md` files (exclude `locked/`, `local-only-*`, `.keep`)
2. If active entries exist: "Found {N} active context items. Resume one, or start fresh?"
   - List entries with topic, lifecycle status, last updated, and first line of Status section
   - Wait for user choice
3. If no entries: proceed as `blank`

## Flow: Handoff

1. List all ephemeral shared-context entries with:
   - Topic name
   - Lifecycle status (active/paused)
   - Last updated timestamp
   - Author (if user-scoped)
   - Branch reference (if present)
2. User selects one or more entries to resume
3. Read selected entries fully into context
4. If a selected entry has a `branch` field:
   - Check if the worktree exists at `repos/{repo}___wt-{branch-slug}/`
   - If yes: confirm it's checked out to the right branch
   - If no: offer to create the worktree
5. Summarize loaded state: "Resuming {topic}. Branch: {branch}. Last session: {status summary}. Next: {next steps}."

## Flow: Blank

1. Ask: "What are you working on?"
2. Wait for response. Determine if this is a feature, bugfix, or chore.
3. Ask which repo this work targets (if multiple repos in workspace.json)
4. Propose branch name following git-conventions rule:
   - "How about `{prefix}/{suggested-slug}`? Or would you prefer something different?"
5. Wait for confirmation or adjustment
6. Create branch from latest default branch:
   ```bash
   cd repos/{repo}
   git fetch origin
   git checkout -b {branch-name} origin/{default-branch}
   ```
7. Create worktree:
   ```bash
   cd repos/
   git -C {repo} worktree add ../{repo}___wt-{branch-slug} {branch-name}
   ```
8. Confirm: "Worktree ready at repos/{repo}___wt-{branch-slug}/"
9. If superpowers-workflow rule is active: run mandatory research phase, then invoke brainstorming skill
10. If not: ask "Ready to start implementing, or want to brainstorm first?"
