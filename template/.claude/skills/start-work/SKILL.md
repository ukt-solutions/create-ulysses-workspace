---
name: start-work
description: Begin or resume a work session. Creates a self-contained work-sessions/{name}/ folder containing the workspace worktree and nested project worktrees. Accepts optional parameter "handoff" or "blank".
---

# Start Work

Begin or resume a persistent work session. Each session lives in its own `work-sessions/{name}/` folder containing one workspace worktree, nested project worktrees, and a unified `session.md` tracker. Sessions can run in parallel from separate terminals.

## Parameters
- `/start-work` (no param) — list your active sessions, then resume or start new
- `/start-work blank` — start new work from scratch
- `/start-work handoff` — list shared context to resume from
- `/start-work all` — list active sessions across all users (for shared debugging or multi-user workspaces)

## Flow: No Parameter

1. Read the current user from `.claude/settings.local.json` → `workspace.user`. If unset, behave as `/start-work all` (no user filter). If the user invoked `/start-work all`, also skip filtering.
2. Walk `work-sessions/` — each `work-sessions/{name}/workspace/session.md` is one session. Read frontmatter for `status`, `description`, `branch`, `repos`, and `user`.
3. Filter to sessions whose `status` is `active` or `paused`. When a current user is known and the user did not pass `all`, additionally filter to sessions whose `user` field matches the current user (or is missing — unscoped legacy sessions stay visible to everyone).
4. If matching sessions exist, present them:
   ```
   Your active work sessions:
     1. migrate-tool (active, last chat ended 2h ago)
        "Rewriting the migration module"
        Branch: bugfix/migrate-rewrite | Repos: my-app

     [N] Start something new

   Which one?
   ```
5. User picks one → resume flow
6. User picks "new" → blank flow
7. If no matching sessions exist but other users have active/paused sessions, note it briefly before falling through to `blank`: "No active sessions for you. {N} session(s) belong to other users — run `/start-work all` to see them." If no sessions exist at all, proceed silently as `blank`.

## Flow: Resume

1. Read the selected session tracker at `work-sessions/{name}/workspace/session.md`
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
5. Restore the task list from `## Tasks` per the `task-list-mirroring` rule:
   ```bash
   cd work-sessions/{name}/workspace
   node .claude/scripts/sync-tasks.mjs --read session.md
   ```
   Pass the parsed `todos` array to `TodoWrite` so the live UI matches the durable state. If the section is missing (legacy session predating this feature), seed it first via `--write` with an empty `todos` array — the helper will insert the bookends.
6. Run history reconstruction (see below)
7. Tell user: "Resuming {name}. Work from `work-sessions/{name}/workspace/`."

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

1. **Check for a configured tracker.** Read `workspace.tracker` from `workspace.json`.

2. **If no tracker is configured:** Ask: "No tracker configured. Want to run `/setup-tracker` first, or start a blank session (no issue linkage)?" If setup-tracker: invoke that skill, then re-enter this flow. If blank: proceed to the description-only path (step 6 below) with no `workItem:` linkage.

3. **Fetch the candidate list via the adapter.** Build the adapter and pull two lists — issues assigned to the current user first, falling back to all unassigned issues if the assigned list is empty:
   ```javascript
   import { createTracker } from './.claude/scripts/trackers/interface.mjs';
   import { readFileSync } from 'node:fs';
   const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
   const tracker = createTracker(ws.workspace.tracker);
   const assigned = await tracker.listAssignedToMe();
   const candidates = assigned.length > 0 ? assigned : await tracker.listUnassigned();
   const fallbackNote = assigned.length === 0 ? '(fallback — no issues assigned to you; showing unassigned)' : '';
   ```

4. **Present the list.** Group by milestone when the adapter provides one; sort by priority label (P1 before P2 before P3) within each group:
   ```
   {fallbackNote}
   Backlog:
     1. [P1 bug] Auth timeout on mobile (gh:3)
     2. [P1 feat] JWT refresh logic (gh:8)

   v0.1:
     3. [P2 feat] Full-text search (gh:5)

     [N] Something new

   Which one, or describe something new?
   ```
   Accept a number or "N".

5. **User picked an existing issue.**
   - If it came from the unassigned fallback list, atomically claim it:
     ```javascript
     try {
       await tracker.claim(issue.id);
     } catch (e) {
       if (e.code === 'ALREADY_ASSIGNED') {
         console.log(`${issue.id} was just claimed by ${e.assignees.join(', ')}. Refreshing list.`);
         // Re-enter step 3 — someone else grabbed the ticket between fetch and claim.
         return restart();
       }
       throw e;
     }
     ```
   - If it came from the assigned-to-me list, skip the claim call (already mine).
   - Generate the session name from the issue title (kebab-case slug, max ~40 chars).
   - Remember `workItem: {issue.id}` for the session tracker.

6. **User picked "Something new" (or fell through from step 2 with no tracker).**
   - Ask for a description, type (`bug` / `feat` / `chore`), priority (`P1` / `P2` / `P3`), optional milestone.
   - If a tracker is configured, create the issue and self-assign:
     ```javascript
     const newIssue = await tracker.createIssue({
       title: description,
       body: `Created at /start-work by ${user}.`,
       labels: [type, priority],
       milestone: milestone || null,
     });
     await tracker.claim(newIssue.id);
     ```
     Remember `workItem: {newIssue.id}` for the session tracker.
   - If no tracker: proceed without a `workItem:` linkage — the session is a pure blank.

7. **Pick repo(s)** — present numbered list from workspace.json, allow multi-select (e.g., `1,3` or `all`).

8. **Propose branch:** `{prefix}/{session-name}` where prefix comes from type (`feature/` for feat, `bugfix/` for bug, `chore/` for chore). Wait for confirmation.

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
- Unified session tracker at `work-sessions/{session-name}/workspace/session.md` (frontmatter + body)
- Active-session pointer at `work-sessions/{session-name}/workspace/.claude/.active-session.json`
- Copies `settings.local.json` into the worktree if it exists at the workspace root

If a `workItem:` was set in step 5 or 6, write it into the tracker's frontmatter via the session-frontmatter helper after creation. This is what `/pause-work` and `/complete-work` use to locate the linked issue.

Register this chat in the tracker's `chatSessions` frontmatter. For new sessions, the session-start hook has already fired (before /start-work was invoked) but the session folder didn't exist yet. Find the current chat's UUID from the most recently modified `.jsonl` file in `~/.claude/projects/{project-path}/` and add the entry manually via the session-frontmatter helper. Subsequent chats on this session will be registered automatically by the hook.

The tracker already reflects the correct state — assignment happened in step 5 or 6 via `adapter.claim()`. Do not write to any local file mirror. There is no `open-work.md`.

### Seed the task list

After session creation, seed the `## Tasks` section in the new tracker so `TodoWrite` has something to mirror. See the `task-list-mirroring` rule for the schema.

```bash
# Build the seed from inside the worktree so the helper resolves workspace.json correctly.
cd work-sessions/{session-name}/workspace
echo '{"todos": []}' | node .claude/scripts/sync-tasks.mjs --write session.md
```

The helper auto-inserts the `Start work` (completed) and `Complete work` (pending) bookends, and resolves the tracker title from `workItem:` if set.

Then call `TodoWrite` with the same seed so the live UI matches:

```javascript
// Pseudocode — call the actual TodoWrite tool.
TodoWrite({
  todos: [
    { content: 'Start work',    activeForm: 'Starting work',    status: 'completed' },
    { content: 'Complete work', activeForm: 'Completing work',  status: 'pending'   },
  ]
});
```

The auto-commit at the end of "Capture prior conversation context" picks up the new section — no separate commit needed.

### Capture prior conversation context

If brainstorming, spec writing, or design discussion happened in this conversation before `/start-work` was called, that reasoning needs to be captured into the session tracker body. Otherwise it will be lost when the conversation ends and `/complete-work` will produce thin release notes.

Check: has the current conversation included substantive discussion (design decisions, requirements exploration, approach selection) before this point?

If yes:
1. Summarize the prior discussion — key decisions, requirements established, approaches chosen/rejected, constraints identified
2. Write the summary into `work-sessions/{session-name}/workspace/session.md`'s body, in a `## Pre-session context` or `## Progress` section
3. Auto-commit from inside the worktree so the capture lands on the session branch:
   ```bash
   cd work-sessions/{session-name}/workspace
   git add session.md
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
- `session.md` is the single source of truth for session state: frontmatter is machine state (status, branch, chatSessions, workItem), body is human content (decisions, progress)
- The `workItem:` field in session frontmatter holds the adapter-prefixed issue ID (e.g., `gh:42`) — the tracker itself is authoritative for status, assignment, and labels
- Session trackers, specs, and plans live at the top of the session worktree and are tracked on the session branch. Pushing the branch carries durable session thinking across machines. `/complete-work` removes them from the branch before the final PR so main's top level stays free of session artifacts
- Worktrees and local artifacts are gitignored — recreate them on first resume on each machine
- Auto-committing session state is a workflow artifact — this intentionally bypasses normal commit conventions
