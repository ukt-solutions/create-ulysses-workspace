---
name: start-work
description: Begin or resume a work session. Creates a self-contained work-sessions/{name}/ folder containing the workspace worktree and nested project worktrees. Accepts optional parameter "handoff" or "blank".
---

# Start Work

Begin or resume a persistent work session. Each session lives in its own `work-sessions/{name}/` folder containing one workspace worktree, nested project worktrees, and a unified `session.md` tracker. Sessions can run in parallel from separate terminals.

## Parameters
- `/start-work` (no param) — check for active sessions, then resume or start new
- `/start-work blank` — start new work from scratch
- `/start-work handoff` — list shared context to resume from

## Flow: No Parameter

1. Walk `work-sessions/` — each `work-sessions/{name}/session.md` is one session. Read frontmatter for status, description, branch, repos.
2. If sessions exist with status `active` or `paused`, present them:
   ```
   Active work sessions:
     1. migrate-tool (active, last chat ended 2h ago)
        "Rewriting the migration module"
        Branch: bugfix/migrate-rewrite | Repos: my-app

     [N] Start something new

   Which one?
   ```
3. User picks one → resume flow
4. User picks "new" → blank flow
5. If no sessions exist: proceed as `blank`

## Flow: Resume

1. Read the selected session tracker at `work-sessions/{name}/session.md`
2. Verify worktrees exist:
   - Workspace: `work-sessions/{name}/workspace/`
   - For each repo in `repos:` frontmatter: `work-sessions/{name}/workspace/repos/{repo}/`
   - If any are missing, recreate from the branch
3. The session-start hook automatically registers each chat in the session tracker's `chatSessions` frontmatter when Claude opens in a worktree. Verify the current chat is registered — if not (e.g., the hook didn't fire), add an entry manually via the session-frontmatter helper.

   Each `chatSessions` entry has this shape:
   ```yaml
   - id: {uuid}
     names: [{name-if-any}]
     started: {iso-timestamp}
     ended: null
   ```
   - `id` is the authoritative identifier — the UUID from Claude Code's session. The session-start hook gets it from `input.session_id`.
   - `names` is a list of all names the chat has had (users can rename). Append, never replace.
   - `ended` is set by the session-end hook when the chat closes.
4. Update the tracker `status:` to `active` if it was `paused`
5. Run history reconstruction (see below)
6. Tell user: "Resuming {name}. Work from `work-sessions/{name}/workspace/`."

### History Reconstruction

On resume, check for uncaptured work from previous chats:

1. Read the session tracker's `chatSessions` list
2. For the most recent ended chat, use its `id` field (UUID) to locate the conversation log at `~/.claude/projects/{project-path}/{id}.jsonl`
3. Check if the session.md body was updated after that chat ended
4. If there's a gap (conversation log has content newer than the body's last update): scan the log and generate a summary of decisions, progress, and context
5. Append the summary to the session.md body's `## Progress` section (or create one if it doesn't exist)
6. Tell user: "Found uncaptured work from your last chat. Updated the session tracker."

If no gap is found, skip silently.

## Flow: Blank (new session)

1. Check if `shared-context/open-work.md` exists and has open items. If so, present them grouped by milestone (highest priority first within each group):
   ```
   Open work items:

   v0.1 — Alpha:
     1. [P1 bug] Auth timeout on mobile (#3)
     2. [P1 feat] JWT refresh logic (#8)

   v0.2 — Beta:
     3. [P2 feat] Full-text search (#5)

   Backlog:
     4. [P3 chore] Remove deprecated endpoints (#7)

     [N] Something not on this list

   Which one, or describe something new?
   ```
2. If user picks an existing item: use its title, type, milestone, and repo. Generate session name from the title.
3. If user describes something new: ask milestone (default to the workspace's `defaultMilestone`) and add it to `open-work.md` as a new item with the next available ID.
4. Determine type: feature, bugfix, or chore (from the work item or user description)
5. Ask which repo(s) — present numbered list from workspace.json, allow selecting multiple (e.g., "1,3" or "all"). Pre-select the repo from the work item if it's from a specific table.
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
- Session folder at `work-sessions/{session-name}/`
- Workspace worktree at `work-sessions/{session-name}/workspace/` with a real `repos/` directory inside
- Project worktree per repo nested at `work-sessions/{session-name}/workspace/repos/{repo}/`
- Unified session tracker at `work-sessions/{session-name}/session.md` (frontmatter + body)
- Active-session pointer at `work-sessions/{session-name}/workspace/.claude/.active-session.json`
- Copies `settings.local.json` into the worktree if it exists at the workspace root

Register this chat in the tracker's `chatSessions` frontmatter. For new sessions, the session-start hook has already fired (before /start-work was invoked) but the session folder didn't exist yet. Find the current chat's UUID from the most recently modified `.jsonl` file in `~/.claude/projects/{project-path}/` and add the entry manually via the session-frontmatter helper. Subsequent chats on this session will be registered automatically by the hook.

### Update open-work.md

Update the work item's status to `in-progress` and populate its Branch field with the session branch. The table uses the 8-column milestone-aware format:
```markdown
| 3 | bug | P1 | v0.1 | in-progress | bugfix/fix-auth | Auth timeout on mobile |
```
If the session tracker has a `workItem:` field (set during the blank flow), use that to find the row. Auto-commit:
```bash
git add shared-context/open-work.md
git commit -m "chore: mark work item #{id} as in-progress"
```

Also record the `workItem:` in the session.md frontmatter so `/complete-work` and `/pause-work` know which item to update.

If `workspace.tracker.sync` is configured, optionally run the sync script to push the status change to the external tracker (ask the user first — they may prefer to batch sync at /complete-work time).

### Capture prior conversation context

If brainstorming, spec writing, or design discussion happened in this conversation before `/start-work` was called, that reasoning needs to be captured into the session tracker body. Otherwise it will be lost when the conversation ends and `/complete-work` will produce thin release notes.

Check: has the current conversation included substantive discussion (design decisions, requirements exploration, approach selection) before this point?

If yes:
1. Summarize the prior discussion — key decisions, requirements established, approaches chosen/rejected, constraints identified
2. Write the summary into `work-sessions/{session-name}/session.md`'s body, in a `## Pre-session context` or `## Progress` section
3. Auto-commit:
   ```bash
   git add work-sessions/{session-name}/session.md
   git commit -m "chore: capture pre-session discussion for {session-name}"
   ```

If no prior discussion: skip silently.

Tell user: "Work session started. Work from `work-sessions/{session-name}/workspace/`."

### Add repo to active session

If there's an active session and the user wants to add a repo (explicitly or prompted by repo-write-detection):

1. Confirm: "Add {repo} to the current session '{session-name}'?"
2. Run the helper script:
   ```bash
   node .claude/scripts/add-repo-to-session.mjs \
     --session-name "{session-name}" \
     --repo "{repo}"
   ```
3. Tell user: "Added {repo}. Worktree at `work-sessions/{session-name}/workspace/repos/{repo}/`."

### Stale worktree check

Before creating a new session, scan for existing sessions:
```bash
ls work-sessions/ 2>/dev/null
```
If stale sessions exist (no recent commits on the branch, no open PR, tracker `status` is `active` but worktrees are gone):
- "You have existing sessions for {names}. Clean up? [y/N]"
- If yes: run cleanup script for each

### Next steps

If superpowers-workflow rule is active: run mandatory research phase, then invoke brainstorming skill.
If not: ask "Ready to start implementing, or want to brainstorm first?"

## Flow: Retroactive (called mid-session)

When /start-work is called after work has already begun:

1. Detect uncommitted changes in `repos/` or `shared-context/`
2. "It looks like you've already been working. Let me formalize this."
3. If changes are on a default branch: stash → create session → pop stash
4. If changes are already on a feature branch: create workspace worktree and nest the existing project worktree(s) under it, or create a fresh session if the work is small enough to re-apply
5. Summarize: "Formalized as work session: {name}. Work from `work-sessions/{name}/workspace/`."

## Notes
- All repos (workspace + project repos) get the same branch name for traceability
- Each session lives in a single self-contained folder at `work-sessions/{name}/`
- The workspace worktree contains a real `repos/` directory with nested project worktrees — no symlink
- `session.md` is the single source of truth: frontmatter is machine state (status, branch, chatSessions), body is human content (decisions, progress)
- Session trackers, specs, and plans inside `work-sessions/{name}/` are tracked in git (via the gitignored-folder-with-tracked-files pattern), so pushing the workspace branch carries durable session thinking across machines
- Worktrees and local artifacts are gitignored — recreate them on first resume on each machine
- Auto-committing session state is a workflow artifact — this intentionally bypasses normal commit conventions
