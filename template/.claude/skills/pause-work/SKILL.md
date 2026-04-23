---
name: pause-work
description: Suspend current work — updates session tracker, captures state to the tracker body, pushes all repos, creates draft PRs. Use when stepping away from work that isn't finished.
---

# Pause Work

Suspend the active work session. Captures state in the session tracker, pushes work, and marks the session as paused for later resumption.

## Flow

### Step 1: Detect active session

Read the active-session pointer from `.claude/.active-session.json` in the current worktree.
If no active session: "No active work session. Nothing to pause."

Read the full session tracker at `work-sessions/{session-name}/workspace/session.md`.

### Step 2: Update session tracker body

Rewrite the `## Progress` section of `work-sessions/{session-name}/workspace/session.md` with:
- What was accomplished in this chat session
- Key decisions made
- Current state of the work
- Specific next steps for whoever resumes

This is a coherent rewrite of the Progress section, not an append (coherent-revisions rule). Leave the frontmatter alone — the session-end hook will mark this chat's `ended` timestamp automatically when the chat closes.

### Step 3: Update frontmatter status and post pause comment on tracker

Use the session-frontmatter helper to set `status: paused` in the tracker's frontmatter.

If the session tracker has a `workItem:` field AND `workspace.tracker` is configured, post a pause comment on the linked issue via the adapter:

```javascript
import { createTracker } from './.claude/scripts/trackers/interface.mjs';
import { readFileSync } from 'node:fs';
const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
if (ws.workspace?.tracker) {
  const tracker = createTracker(ws.workspace.tracker);
  const progressBody = /* the ## Progress section of session.md, as written in Step 2 */;
  const body = [
    `**Session paused by @${currentUser}** (${branch})`,
    '',
    progressBody,
    '',
    `Resume with \`/start-work\` from any worktree on \`${branch}\`.`,
  ].join('\n');
  await tracker.comment(workItem, body);
}
```

If `workItem:` is unset, skip the comment — this is a blank session with no tracker linkage.

If the comment fails (tracker unreachable, auth expired), report the error but do not block the pause. The pause state lives locally in the session tracker regardless.

### Step 4: Flush task list to session.md

Before the commit picks it up, flush current `TodoWrite` state to `## Tasks` per the `task-list-mirroring` rule:

```bash
cd work-sessions/{session-name}/workspace
echo '<JSON-of-current-todos>' | node .claude/scripts/sync-tasks.mjs --write session.md
```

The `<JSON-of-current-todos>` is the same shape Claude has been maintaining via `TodoWrite`:

```json
{
  "todos": [
    { "content": "...", "activeForm": "...", "status": "pending|in_progress|completed" }
  ]
}
```

The helper enforces the bookend invariant — pass whatever current state you have, including any missing or misplaced bookends, and the helper will normalize.

### Step 5: Commit and push workspace

```bash
# From the workspace worktree
cd work-sessions/{session-name}/workspace
git add .
git commit -m "handoff: pause {session-name}"
git push -u origin {branch}
```

### Step 6: Push project repos

```bash
# For each repo in the tracker's repos:
cd work-sessions/{session-name}/workspace/repos/{repo}
git push -u origin {branch}
```

### Step 7: Create draft PRs

```bash
# For each repo in the tracker's repos:
cd work-sessions/{session-name}/workspace/repos/{repo}
gh pr create --draft --title "WIP: {description}" --body "Work in progress. Session paused."

# Workspace repo — from the workspace worktree
gh pr create --draft --title "context: {session-name} (paused)" --body "Workspace context for paused session."
```

If PRs already exist, update them to draft status if needed.

### Step 8: Confirm

"Session '{session-name}' paused. Resume anytime with /start-work."

No worktree cleanup — the session is meant to be resumed. The `work-sessions/{session-name}/` folder stays intact.

## Notes
- Pause writes ONLY to `work-sessions/{session-name}/workspace/session.md` — never to ongoing or root shared-context
- The session tracker's frontmatter stays in the session folder — it's the resume mechanism
- Draft PRs signal work-in-progress without implying merge readiness
- Auto-committing the pause capture is a workflow artifact — this intentionally bypasses normal commit conventions
