---
name: start-work
description: Begin or resume a work session. Creates a self-contained work-sessions/{name}/ folder containing the workspace worktree and nested project worktrees. Accepts optional parameter "handoff" or "blank".
---

# Start Work

Two lifecycles share this skill. `workspace.sessionModel` in `workspace.json` selects for new work: `"task"` routes new work to **Flow: Task** (session model v2 — no session folder, no `session.md`); absent or `"session"` keeps the existing flows below, unchanged. Resuming an existing `work-sessions/` session always uses the existing Resume flow regardless of the setting.

Begin or resume a persistent work session. Each session lives in its own `work-sessions/{name}/` folder containing one workspace worktree, nested project worktrees, and a unified `session.md` tracker. Sessions can run in parallel from separate terminals.

## Parameters
- `/start-work` (no param) — list your active sessions, then resume or start new
- `/start-work blank` — start new work from scratch
- `/start-work handoff` — list shared context to resume from
- `/start-work all` — list active sessions across all users (for shared debugging or multi-user workspaces)

## Flow: Task (session model v2)

New work as a task: one tracker issue, one branch, one worktree per repo the work touches. This flow creates no `work-sessions/` folder, no `session.md`, and seeds no task list — the issue, the branch, and the chat record are the entire state. The chat stays at the workspace root — `{launcher-root}`, the absolute path on the `Workspace root:` line the SessionStart hook injects (at /start-work time you are normally already there); the worktrees are reached by path.

If `workspace.tracker` is absent, say tracking is off and skip step 1 — but still ask for the type (`bug` / `feat` / `chore`) and a one-line description, because the type picks the branch prefix — then continue with steps 2–6. What that costs: without a tracker there is no `workItem` and no issue to close at completion — the task is still recorded on the chat record (with no work item, keyed by repo + branch), so `/complete-work` finds it from the launcher like any other task.

1. **Identify or create the tracker issue and claim it.** If the invocation's arguments already name an issue — `gh:N`, `#N`, or an issue URL — normalize it to the adapter's id (`#42` and a `.../issues/42` URL both mean `gh:42`) and fetch it with `tracker.getIssue(id)`. Then check whether the issue already has a task before claiming anything — another chat may have started it (gh:188):

   ```bash
   node .claude/scripts/chat-record.mjs --root . --owner "{workItem}"
   ```

   Exit 1 means no chat owns a task for the issue: claim it when it is not yet assigned to you (with the same `ALREADY_ASSIGNED` handling as the fallback pick below) and skip the candidate list entirely. Exit 0 prints `{ chat, branches }` — a task exists, one `{ branch, repos }` per branch the issue is open on (gh:206: one issue may carry several branches, each its own worktree and PR). First make sure the worktrees are there: run step 4's `--create` once per branch, for each repo in that branch's `repos`; over an existing branch or worktree `--create` REUSES what it finds (`created: false`) — it never fails or duplicates. Then ask the operator which way to take it:
   - **Adopt into this chat** — record each adopted branch with step 5's `--add-task`, and remove it from the old chat's record (`--remove-task --chat "{owner.chat}" --work-item "{workItem}" --branch "{branch}" --repo "{repo}"`) only when the operator says that chat is done with it. While both chats still work a branch, both records legitimately list it — the branch and worktrees are shared, not duplicated — and a sibling branch the owner keeps is not this adoption's to take.
   - **Leave it with the owner** — message the owning chat via SendMessage using the name `--owner` printed (the record name doubles as the session-registry name SendMessage reaches a chat by) and stop here.
   - When `--owner` names this chat, it is a resume of your own task: reuse the worktrees as above and continue.

   Notes another chat will need to continue the task never go in this chat's drawer — the drawer is per-chat and machine-local. Put them on the issue as a comment (`await tracker.comment("{workItem}", body)`), where any chat can read them.

   When the invocation's arguments name no issue, list the candidates — the same adapter calls as Flow: Blank steps 3–6 (an issue picked from the list gets the same `--owner` check once its id is known):

   ```javascript
   import { createTracker } from './.claude/scripts/trackers/interface.mjs';
   import { readFileSync } from 'node:fs';
   const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
   const tracker = createTracker(ws.workspace.tracker);
   const assigned = await tracker.listAssignedToMe();
   const candidates = assigned.length > 0 ? assigned : await tracker.listUnassigned();
   ```

   Present the list as Flow: Blank step 4 does. When the pick came from the unassigned fallback, claim it atomically and re-fetch on `ALREADY_ASSIGNED` exactly as Blank step 5 shows; for "something new", create and self-assign per Blank step 6:

   ```javascript
   const newIssue = await tracker.createIssue({
     title: description,
     body: `Created at /start-work by ${user}.`,
     labels: [type, priority],
     milestone: milestone || null,
   });
   await tracker.claim(newIssue.id);
   ```

   The epic flow from Blank step 6 applies here too — `tracker.listEpics()` read before the create (a failure there is reported and skipped, never fatal), the picker offered only when it is non-empty.

   Remember `workItem: {issue.id}`.

2. **Pick repo(s)** — the same numbered multi-select as Blank step 7 (e.g. `1,3` or `all`), defaulting to the repo marked `"primary": true` under `repos` in `workspace.json`, falling back to the first entry when none is marked. The list also offers the **workspace repo itself**, shown as `workspace (this repo)` and addressed as `.`. Include it when the task changes anything tracked in the workspace repo — `workspace-context/`, the workspace's own `.claude/` (rules, hooks, scripts, skills), or, in a dogfood workspace, mirrors of template changes. Steps 4 and 5 take `.` like any other repo name (`--repo "."`).

3. **Propose the branch** — `{prefix}/{slug}` with the prefix from type (`feature/`, `bugfix/`, `chore/`), per the branch-naming step in Flow: Blank.

4. **Create one worktree per repo the work touches:**
   ```bash
   node .claude/scripts/task-worktree.mjs --root . --create --repo "{repo}" --branch "{branch}"
   ```
   The script fetches origin best-effort (offline is fine) before choosing the base. A project repo's worktree lands at `repos/{repo}/.claude/worktrees/{slug}/` — Claude Code's native worktree location — based on `origin/{defaultBranch}` when that ref exists and the local `{defaultBranch}` otherwise — a local-mode repo (`merge: "local"`) bases on the local `{defaultBranch}` itself, since its merges land there and its origin ref never advances — and never tracking it. For `.` the worktree lands at `.claude/worktrees/{slug}/` — the same native location, one level up — based on the workspace origin's HEAD (falling back to `main`); the workspace's own `.gitignore` already covers the path. A repo without a forge remote — no origin at all, or `merge: "local"` in `workspace.json` — runs the task in local mode: nothing is pushed for it, and `/complete-work` merges it into its source clone instead.

5. **Record the task on this chat's record:**
   ```bash
   node .claude/scripts/chat-record.mjs --root . --add-task --chat "{chat}" --work-item "{workItem}" --branch "{branch}" --repo "{repo}"
   ```
   Omit `--work-item` when the task has none — the entry is recorded with a null work item, keyed by repo + branch. `{chat}` is the name from the `Chat record:` line the SessionStart hook injected into this conversation. If there is no such line, run `node .claude/scripts/chat-record.mjs --whoami --root .` first — compaction can drop the hook line, and this recovers the name by matching the chat's session id. When that too prints nothing, say so and skip recording rather than guessing a name.

6. **Tell the user where the work happens:** the worktree path(s) above — edits belong there, not in the source clones at `repos/{repo}/`. Work continues from this chat by path. A chat started inside a **project** worktree would not load the workspace's conventions or hooks (a worktree is a context boundary), so staying here is the default. A `.` worktree does load a copy of the workspace's `CLAUDE.md`/`.claude/` — but with the worktree as root, so its chat records land in the worktree's own scratchpad rather than the launcher's; the task still belongs to this chat.

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
3. The session-start hook automatically registers each chat in the session tracker's `chatSessions` frontmatter when Claude opens in a worktree. A lane chat resuming from the launcher is never opened there, so the hook cannot register it. Verify the current chat is registered — from either starting point — and when it is not, append an entry using the invocation shown under "Create work session" below (the helper is an importable library, not a CLI). Take the chat's UUID from this chat's record: `node .claude/scripts/chat-record.mjs --root . --read "{chat}"` prints it as `sessionId` (the `Chat record:` hook line names `{chat}`). The id matters — it is what `/complete-work` later matches this session by from the launcher.

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
   cd "work-sessions/{name}/workspace"
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
   - If a tracker is configured, read the epic list first — a tracker/epic failure must surface before anything is created, and it never blocks issue creation — then create the issue and self-assign:
     ```javascript
     let epics = [];
     try {
       epics = await tracker.listEpics();
     } catch (e) {
       console.log(`Skipping the epic picker — could not list epics: ${e.message}`);
     }

     const newIssue = await tracker.createIssue({
       title: description,
       body: `Created at /start-work by ${user}.`,
       labels: [type, priority],
       milestone: milestone || null,
     });
     await tracker.claim(newIssue.id);

     // Offered only when epics already exist; teams without them see
     // nothing new. Present a numbered menu: the existing epics, "[0] No
     // epic", and "[N] New epic…". Create only on the explicit new-epic
     // choice (tracker.createEpic({ name })), then assign the pick:
     if (epics.length > 0) {
       await tracker.setIssueEpic(newIssue.id, chosenName /* or null for no epic */);
     }
     ```
     `setIssueEpic` replaces any epic the issue already carries, and an unknown name throws — never invent epic names to satisfy it. If it itself fails after the issue exists, report that and continue: the issue is already created and claimed, and nothing after that point is worth aborting over.
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

If a `workItem:` was set in step 5 or 6, write it into the tracker's frontmatter after
creation. `/pause-work` and `/complete-work` both use this to locate the linked issue, and
a session created without it looks fine until one of them silently cannot find the ticket.

`.claude/lib/session-frontmatter.mjs` is a **library, not a CLI** — running it with flags
does nothing and exits 2. Import it:

```bash
cd "work-sessions/{session-name}/workspace"
node --input-type=module -e '
import { updateSessionFile, readSessionFields } from "./.claude/lib/session-frontmatter.mjs";
updateSessionFile("session.md", { workItem: "{workItem}" });
console.log("workItem =", readSessionFields("session.md").workItem);
'
```

Read the value back, as above, and confirm it before moving on — this write has failed
silently before (gh:143).

Register this chat in the tracker's `chatSessions` frontmatter. For new sessions, the session-start hook has already fired (before /start-work was invoked) but the session folder didn't exist yet. Find the current chat's UUID from the most recently modified `.jsonl` file in
`~/.claude/projects/{project-path}/` and append the entry with the same library:

```bash
node --input-type=module -e '
import { updateSessionFile, readSessionFields } from "./.claude/lib/session-frontmatter.mjs";
const existing = readSessionFields("session.md").chatSessions || [];
updateSessionFile("session.md", {
  chatSessions: [...existing, { id: "{uuid}", names: [], started: new Date().toISOString(), ended: null }],
});
'
```

Append — never replace: the list is the session'"'"'s whole chat history. Subsequent chats are
registered automatically by the hook.

The tracker already reflects the correct state — assignment happened in step 5 or 6 via `adapter.claim()`. Do not write to any local file mirror. There is no `open-work.md`.

### Seed the task list

After session creation, seed the `## Tasks` section in the new tracker so `TodoWrite` has something to mirror. See the `task-list-mirroring` rule for the schema.

```bash
# Build the seed from inside the worktree so the helper resolves workspace.json correctly.
cd "work-sessions/{session-name}/workspace"
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

If brainstorming, spec writing, or design discussion happened in this conversation before `/start-work` was called, that reasoning needs to be captured into the session tracker body. Otherwise it will be lost when the conversation ends and `/complete-work` will write a thin PR body.

Check: has the current conversation included substantive discussion (design decisions, requirements exploration, approach selection) before this point?

If yes:
1. Summarize the prior discussion — key decisions, requirements established, approaches chosen/rejected, constraints identified
2. Write the summary into `work-sessions/{session-name}/workspace/session.md`'s body, in a `## Pre-session context` or `## Progress` section
3. Auto-commit from inside the worktree so the capture lands on the session branch:
   ```bash
   cd "work-sessions/{session-name}/workspace"
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

1. Detect uncommitted changes in `repos/` or `workspace-context/`
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
