---
name: start-work
description: Begin or resume a work session. Creates workspace + project worktrees for parallel session support. Accepts optional parameter "handoff" or "blank".
---

# Start Work

Begin or resume a persistent work session. Each session gets its own workspace worktree and one worktree per project repo, enabling parallel sessions in separate terminal windows.

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
        Branch: bugfix/migrate-rewrite | Repos: create-claude-workspace
     
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
   - For each repo in `marker.repos`: `repos/{session-name}___wt-{repo}/`
   - If any are missing, recreate from the branch
3. The session-start hook automatically registers each chat in the session marker's `chatSessions` array when Claude opens in a worktree. Verify the current chat is registered — if not (e.g., the hook didn't fire), register it manually.

   Each `chatSessions` entry has this format:
   ```json
   { "id": "{uuid}", "names": ["{name-if-any}"], "started": "{iso-timestamp}", "ended": null }
   ```
   - `id` is the authoritative identifier — the UUID from Claude Code's session. The session-start hook gets it from `input.session_id`.
   - `names` is an array tracking all names the session has had (users can rename). Append, never replace.
   - `ended` is set by the session-end hook when the chat closes.
4. Update marker status to `active` if it was `paused`
5. Run history reconstruction (see below)
6. Tell user: "Resuming {name}. Work from `repos/{session-name}___wt-workspace/`."

### History Reconstruction

On resume, check for uncaptured work from previous chats:

1. Read the session marker's `chatSessions` array
2. For the most recent ended chat entry, use its `id` field (UUID) to locate the conversation log at `~/.claude/projects/{project-path}/{id}.jsonl`
3. Check if the inflight tracker was updated after that chat ended
4. If there's a gap (conversation log has content newer than the tracker's last update): scan the log and generate a summary of decisions, progress, and context
5. Append the summary to the inflight tracker
6. Tell user: "Found uncaptured work from your last chat. Updated the session tracker."

If no gap is found, skip silently.

## Flow: Blank (new session)

1. Ask: "What are you working on?"
2. Wait for response
3. Generate session name from description (kebab-case slug)
4. Determine type: feature, bugfix, or chore
5. Ask which repo(s) — present numbered list from workspace.json, allow selecting multiple (e.g., "1,3" or "all")
6. Propose branch: "How about `{prefix}/{session-name}`?"
7. Wait for confirmation

### Create work session

Run the helper script:
```bash
node .claude/scripts/create-work-session.mjs \
  --session-name "{session-name}" \
  --branch "{branch}" \
  --repo "{repo1},{repo2}" \
  --user "{user}" \
  --description "{description}"
```

The script creates:
- Workspace worktree at `repos/{session-name}___wt-workspace/`
- Project worktree per repo at `repos/{session-name}___wt-{repo}/`
- Symlinks `repos/` into the workspace worktree
- Copies `settings.local.json` into the worktree
- Session marker in `.claude-scratchpad/`
- Active-session pointer in the worktree's `.claude-scratchpad/`
- Inflight tracker in `shared-context/{user}/inflight/`

Register this chat in the marker's `chatSessions` array. For new sessions, the session-start hook has already fired (before /start-work was invoked) but the session didn't exist yet. Find the current chat's UUID from the most recently modified `.jsonl` file in `~/.claude/projects/{project-path}/` and add the entry manually. Subsequent chats on this session will be registered automatically by the hook.

### Capture prior conversation context

If brainstorming, spec writing, or design discussion happened in this conversation before `/start-work` was called, that reasoning needs to be captured into the inflight tracker. Otherwise it will be lost when the conversation ends and `/complete-work` will produce thin release notes.

Check: has the current conversation included substantive discussion (design decisions, requirements exploration, approach selection) before this point?

If yes:
1. Summarize the prior discussion — key decisions, requirements established, approaches chosen/rejected, constraints identified
2. Write the summary into the inflight tracker's Progress section at `shared-context/{user}/inflight/session-{session-name}.md` (in the workspace worktree)
3. Auto-commit: `git add shared-context/ && git commit -m "chore: capture pre-session discussion for {session-name}"`

If no prior discussion: skip silently.

Tell user: "Work session started. Work from `repos/{session-name}___wt-workspace/`."

### Add repo to active session

If there's an active session and the user wants to add a repo (explicitly or prompted by repo-write-detection):

1. Confirm: "Add {repo} to the current session '{session-name}'?"
2. Run the helper script:
   ```bash
   node .claude/scripts/add-repo-to-session.mjs \
     --session-name "{session-name}" \
     --repo "{repo}"
   ```
3. Tell user: "Added {repo}. Worktree at `repos/{session-name}___wt-{repo}/`."

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
- All repos (workspace + project repos) get the same branch name for traceability
- Each session gets its own workspace worktree plus one worktree per project repo
- The workspace worktree has a `repos/` symlink for project worktree access
- inflight/ is created per work session, consumed by /complete-work
- Auto-committing session markers is a workflow artifact — this intentionally bypasses normal commit conventions
