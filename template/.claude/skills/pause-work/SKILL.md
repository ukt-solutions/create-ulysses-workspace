---
name: pause-work
description: Suspend current work — updates session marker, captures state to inflight tracker, pushes all repos, creates draft PRs. Use when stepping away from work that isn't finished.
---

# Pause Work

Suspend the active work session. Captures state, pushes work, and marks the session as paused for later resumption.

## Flow

### Step 1: Detect active session

Read the active-session pointer from `.claude-scratchpad/.active-session.json`.
If no active session: "No active work session. Nothing to pause."

Read the full session marker from the main root's `.claude-scratchpad/`.

### Step 2: Update inflight tracker

Write a status summary to the inflight tracker at `shared-context/{user}/inflight/session-{session-name}.md`:

Update the Progress section with:
- What was accomplished in this chat session
- Key decisions made
- Current state of the work
- Specific next steps for whoever resumes

This is a coherent rewrite of the Progress section, not an append (coherent-revisions rule).

### Step 3: Update session marker

Set `status: "paused"` and record this chat's `ended` timestamp in the marker.

### Step 4: Commit and push workspace

```bash
# From the workspace worktree
git add shared-context/
git commit -m "handoff: pause {session-name}"
git push -u origin {branch}
```

### Step 5: Push project repos

```bash
# For each repo in marker.repos:
cd repos/{session-name}___wt-{repo}
git push -u origin {branch}
```

### Step 6: Create draft PRs

```bash
# For each repo in marker.repos:
cd repos/{session-name}___wt-{repo}
gh pr create --draft --title "WIP: {description}" --body "Work in progress. Session paused."

# Workspace repo — from workspace worktree
gh pr create --draft --title "context: {session-name} (paused)" --body "Workspace context for paused session."
```

If PRs already exist, update them to draft status if needed.

### Step 7: Confirm

"Session '{session-name}' paused. Resume anytime with /start-work."

No worktree cleanup — the session is meant to be resumed.

## Notes
- Pause writes ONLY to `{user}/inflight/` — never to ongoing or root shared-context
- The session marker stays in `.claude-scratchpad/` — it's the resume mechanism
- Draft PRs signal work-in-progress without implying merge readiness
- Auto-committing the pause capture is a workflow artifact — this intentionally bypasses normal commit conventions
