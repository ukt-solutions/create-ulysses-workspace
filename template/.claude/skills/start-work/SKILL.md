---
name: start-work
description: Begin or resume a work session. Creates workspace + project worktrees for parallel session support. Accepts optional parameter "handoff" or "blank".
---

# Start Work

Begin or resume a persistent work session. Each session gets its own workspace worktree and project worktree, enabling parallel sessions in separate terminal windows.

## Parameters
- `/start-work` (no param) — check for active sessions, then resume or start new
- `/start-work blank` — start new work from scratch
- `/start-work handoff` — list shared context to resume from

## Flow: No Parameter

1. Read session markers from `.claude-scratchpad/` (all `.work-session-*.json` files)
2. If active sessions exist, present them:
   ```
   Active work sessions:
     1. migrate-tool (active, last chat ended 2h ago)
        "Rewriting the migration module"
        Branch: bugfix/migrate-rewrite | Repo: create-claude-workspace
     
     [N] Start something new
   
   Which one?
   ```
3. User picks one → resume flow
4. User picks "new" → blank flow
5. If no sessions exist: proceed as `blank`

## Flow: Resume

1. Read the selected session marker
2. Verify worktrees exist:
   - Workspace: `repos/{session-name}___wt-workspace/`
   - Project: `repos/{session-name}___wt-{repo}/`
   - If missing, recreate from the branch
3. Register this chat in the session marker:
   ```bash
   # Read the marker, append this chat's session ID to chatSessions with ended: null
   ```
4. Update marker status to `active` if it was `paused`
5. Run history reconstruction (see below)
6. Tell user: "Resuming {name}. Work from `repos/{session-name}___wt-workspace/`."

### History Reconstruction

On resume, check for uncaptured work from previous chats:

1. Read the session marker's `chatSessions` array
2. For the most recent ended chat, check if the inflight tracker was updated after it ended
3. Look in `~/.claude/projects/{project-path}/` for message history matching the chat session ID
4. If there's a gap (history is newer than tracker): scan those messages and generate a summary
5. Append the summary to the inflight tracker
6. Tell user: "Found uncaptured work from your last chat. Updated the session tracker."

If no gap is found, skip silently.

## Flow: Blank (new session)

1. Ask: "What are you working on?"
2. Wait for response
3. Generate session name from description (kebab-case slug)
4. Determine type: feature, bugfix, or chore
5. Ask which repo (if multiple repos in workspace.json)
6. Propose branch: "How about `{prefix}/{session-name}`?"
7. Wait for confirmation

### Create work session

Run the helper script:
```bash
node .claude/scripts/create-work-session.mjs \
  --session-name "{session-name}" \
  --branch "{branch}" \
  --repo "{repo}" \
  --user "{user}" \
  --description "{description}"
```

The script creates:
- Workspace worktree at `repos/{session-name}___wt-workspace/`
- Project worktree at `repos/{session-name}___wt-{repo}/`
- Symlinks `repos/` into the workspace worktree
- Copies `settings.local.json` into the worktree
- Session marker in `.claude-scratchpad/`
- Active-session pointer in the worktree's `.claude-scratchpad/`
- Inflight tracker in `shared-context/{user}/inflight/`

Register this chat's session ID in the marker.

Tell user: "Work session started. Work from `repos/{session-name}___wt-workspace/`."

### Stale worktree check

Before creating a new session, scan for existing worktrees:
```bash
ls repos/ | grep '___wt-'
```
If stale worktrees exist (no recent commits, no open PR):
- "You have existing worktrees for {sessions}. Clean up? [y/N]"
- If yes: run cleanup script for each

### Next steps

If superpowers-workflow rule is active: run mandatory research phase, then invoke brainstorming skill.
If not: ask "Ready to start implementing, or want to brainstorm first?"

## Flow: Retroactive (called mid-session)

When /start-work is called after work has already begun:

1. Detect uncommitted changes in repos/ or shared-context/
2. "It looks like you've already been working. Let me formalize this."
3. If changes are on a default branch: stash → create session → pop stash
4. If changes are already on a feature branch: create workspace worktree to match
5. Summarize: "Formalized as work session: {name}. Work from `repos/{name}___wt-workspace/`."

## Notes
- Both repos get the same branch name for traceability
- Each session gets its own workspace worktree — the root stays on main
- The workspace worktree has a `repos/` symlink for project worktree access
- inflight/ is created per work session, consumed by /complete-work
- Auto-committing session markers is a workflow artifact — this intentionally bypasses normal commit conventions
