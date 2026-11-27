---
name: start-work
description: Start new work as a task — one tracker issue, one branch, one worktree per repo the work touches, with the chat staying at the workspace root. Accepts an optional issue id, "handoff" or "blank".
---

# Start Work

Work starts as a **task**: one tracker issue, one branch, one worktree per repo the work touches — the issue, the branch and the chat record are the entire state. CLAUDE.md does not import `workspace.json`: take `tracker` and the repo names from the SessionStart hook's `Workspace config (workspace.json):` line when it is in context, else read the file.

Sessions from the lifecycle earlier template versions had are neither started nor resumed from here. A workspace that still holds them is told so at every session start, and `/migrate-sessions` is how each one is drained.

## Parameters
- `/start-work` (no param) — start new work as a task
- `/start-work gh:42` — start a task on that issue (`#42` and an issue URL mean the same)
- `/start-work blank` — the same as no parameter (kept so the invocation from earlier versions still works)
- `/start-work handoff` — list the handoff files and resume from the one the operator picks: the work item it names is the task to start or resume

## Flow

The chat stays at the workspace root — `{launcher-root}`, the absolute path on the `Workspace root:` line the SessionStart hook injects (at /start-work time you are normally already there); the worktrees are reached by path.

If `workspace.tracker` is absent (the hook's `Workspace config` line reads `tracker: off`), say tracking is off and skip step 1 — but still ask for the type (`bug` / `feat` / `chore`) and a one-line description, because the type picks the branch prefix — then continue with steps 2–6. What that costs: without a tracker there is no `workItem` and no issue to close at completion — the task is still recorded on the chat record (with no work item, keyed by repo + branch), so `/complete-work` finds it from the launcher like any other task.

> **Quoting.** Command values go in single quotes, and a `'` inside a value is written `'\''`: chat text in double quotes would let `$(…)` or backticks run before the command starts.

**Invoked as `/start-work handoff`: settle the work from a handoff before step 1.** List the handoff files for the operator to pick from — every `handoff_*.md` in the chat drawers under `workspace-scratchpad/chats/*/` (each chat has its own drawer, so one is usually in an earlier chat's), and every `handoff_*.md` under `workspace-context/team-member/{user}/` and `workspace-context/shared/`, the `local-only-` drafts among them. With none to list, say so and take step 1 as though `handoff` had not been given. Read the one picked. When its frontmatter names a work item (`workItem: {id}`), the invocation is now `/start-work {id}`: step 1's issue-named path starts that issue's task, or resumes it when a chat already has one — adopting it into this chat, leaving it with its owner, or continuing your own. When it names none, its `## Next Steps` is the work at hand: take the issue from step 1's list, or describe something new, and let the branch and repo it mentions default steps 2 and 3. Either way the flow continues from step 1.

1. **Identify or create the tracker issue and claim it.** If the invocation's arguments already name an issue — `gh:N`, `#N`, or an issue URL — normalize it to the adapter's id (`#42` and a `.../issues/42` URL both mean `gh:42`) and fetch it with `tracker.getIssue(id)`. Then check whether the issue already has a task before claiming anything — another chat may have started it (gh:188):

   ```bash
   node .claude/scripts/chat-record.mjs --root . --owner '{workItem}'
   ```

   Exit 1 means no chat owns a task for the issue: claim it when it is not yet assigned to you (with the same `ALREADY_ASSIGNED` handling as the fallback pick below) and skip the candidate list entirely. Exit 0 prints `{ chat, branches }` — a task exists, one `{ branch, repos }` per branch the issue is open on (gh:206: one issue may carry several branches, each its own worktree and PR). First make sure the worktrees are there: run step 4's `--create` once per branch, for each repo in that branch's `repos`; over an existing branch or worktree `--create` REUSES what it finds (`created: false`) — it never fails or duplicates. Then ask the operator which way to take it:
   - **Adopt into this chat** — record each adopted branch with step 5's `--add-task`, and remove it from the old chat's record (`--remove-task --chat '{owner.chat}' --work-item '{workItem}' --branch '{branch}' --repo '{repo}'`) only when the operator says that chat is done with it. While both chats still work a branch, both records legitimately list it — the branch and worktrees are shared, not duplicated — and a sibling branch the owner keeps is not this adoption's to take.
   - **Leave it with the owner** — message the owning chat via SendMessage using the name `--owner` printed (the record name doubles as the session-registry name SendMessage reaches a chat by) and stop here.
   - When `--owner` names this chat, it is a resume of your own task: reuse the worktrees as above and continue.

   Notes another chat will need to continue the task never go in this chat's drawer — the drawer is per-chat and machine-local. Put them on the issue as a comment (`await tracker.comment("{workItem}", body)`), where any chat can read them.

   When the invocation's arguments name no issue, the issue is picked or created here instead:

   1. **Fetch the candidate list through the adapter** — the issues assigned to the current user first, falling back to all unassigned issues when that list is empty:
      ```javascript
      import { createTracker } from './.claude/scripts/trackers/interface.mjs';
      import { readFileSync } from 'node:fs';
      const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
      const tracker = createTracker(ws.workspace.tracker);
      const assigned = await tracker.listAssignedToMe();
      const candidates = assigned.length > 0 ? assigned : await tracker.listUnassigned();
      const fallbackNote = assigned.length === 0 ? '(fallback — no issues assigned to you; showing unassigned)' : '';
      ```
   2. **Present the list.** Group by milestone when the adapter provides one; sort by priority label (P1 before P2 before P3) within each group:
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
   3. **The operator picked an existing issue.** Its id is known now, so run the same `--owner` check as above and follow the same three outcomes — another chat may already have a task for it. When the task is this chat's to start, take the issue over:
      - If it came from the unassigned fallback list, claim it atomically:
        ```javascript
        try {
          await tracker.claim(issue.id);
        } catch (e) {
          if (e.code === 'ALREADY_ASSIGNED') {
            console.log(`${issue.id} was just claimed by ${e.assignees.join(', ')}. Refreshing list.`);
            // Back to the candidate list — someone else grabbed the ticket between fetch and claim.
            return restart();
          }
          throw e;
        }
        ```
      - If it came from the assigned-to-me list, skip the claim call (already mine).
   4. **The operator described something new.** Ask for the type (`bug` / `feat` / `chore`), priority (`P1` / `P2` / `P3`), and an optional milestone. Read the epic list first — a tracker or epic failure must surface before anything is created, and it never blocks issue creation — then create the issue and self-assign:
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

   Remember `workItem: {issue.id}`.

2. **Pick repo(s)** — a numbered list from `repos` in `workspace.json` with multi-select (`1,3` or `all`), defaulting to the repo marked `"primary": true`, falling back to the first entry when none is marked. The list also offers the **workspace repo itself**, shown as `workspace (this repo)` and addressed as `.`. Include it when the task changes anything tracked in the workspace repo — `workspace-context/`, the workspace's own `.claude/` (rules, hooks, scripts, skills), or, in a dogfood workspace, mirrors of template changes. Steps 4 and 5 take `.` like any other repo name (`--repo "."`).

3. **Propose the branch** — `{prefix}/{slug}`, where the prefix comes from the type (`feature/` for `feat`, `bugfix/` for `bug`, `chore/` for `chore`) and `{slug}` is a kebab-case slug of the issue title, or of the description when there is no issue. Wait for confirmation.

4. **Create one worktree per repo the work touches:**
   ```bash
   node .claude/scripts/task-worktree.mjs --root . --create --repo '{repo}' --branch '{branch}'
   ```
   The script fetches origin best-effort (offline is fine) before choosing the base. A project repo's worktree lands at `repos/{repo}/.claude/worktrees/{slug}/` — Claude Code's native worktree location — based on `origin/{defaultBranch}` when that ref exists and the local `{defaultBranch}` otherwise — a local-mode repo (`merge: "local"`) bases on the local `{defaultBranch}` itself, since its merges land there and its origin ref never advances — and never tracking it. For `.` the worktree lands at `.claude/worktrees/{slug}/` — the same native location, one level up — based on the workspace origin's HEAD (falling back to `main`); the workspace's own `.gitignore` already covers the path. A repo without a forge remote — no origin at all, or `merge: "local"` in `workspace.json` — runs the task in local mode: nothing is pushed for it, and `/complete-work` merges it into its source clone instead.

5. **Record the task on this chat's record:**
   ```bash
   node .claude/scripts/chat-record.mjs --root . --add-task --chat '{chat}' --work-item '{workItem}' --branch '{branch}' --repo '{repo}'
   ```
   Omit `--work-item` when the task has none — the entry is recorded with a null work item, keyed by repo + branch. `{chat}` is the name from the `Chat record:` line the SessionStart hook injected into this conversation. If there is no such line, run `node .claude/scripts/chat-record.mjs --whoami --root .` first — compaction can drop the hook line, and this recovers the name by matching the chat's session id. When that too prints nothing, say so and skip recording rather than guessing a name.

6. **Tell the user where the work happens:** the worktree path(s) above — edits belong there, not in the source clones at `repos/{repo}/`. Work continues from this chat by path. A chat started inside a **project** worktree would not load the workspace's conventions or hooks (a worktree is a context boundary), so staying here is the default. A `.` worktree does load a copy of the workspace's `CLAUDE.md`/`.claude/` — but with the worktree as root, so its chat records land in the worktree's own scratchpad rather than the launcher's; the task still belongs to this chat.

## Retroactive (called mid-session)

Work that began without `/start-work` is formalized as a task, like any other new work: run **Flow** for the issue, the branch and the worktrees, then carry the uncommitted changes over into the new worktrees.

**Carry changes over by the stash entry's SHA, never with a bare pop.** Every worktree of a repository shares one stash stack, so another chat's entry can be `stash@{0}` by the time a pop runs — a pop would apply that one and drop it. Take one repository at a time, wherever its changes sit. `{source}` is where they are — `repos/{repo}/` for a project repo, the workspace root (`.`) for the workspace repo itself — `{worktree}` is the task worktree step 4 of **Flow** created for that repository, and `{slug}` is the branch's slug, so the entry is recognizable in the list:

1. **Stash the changes where they are**, tracked edits and untracked files alike:
   ```bash
   git -C '{source}' stash push -u -m 'start-work-{slug}'
   ```
2. **Capture the new entry's SHA** from the list — the line whose message is yours, and the newest such line if an earlier attempt left one:
   ```bash
   git -C '{source}' stash list --format='%gd %H %gs'
   ```
3. **Apply that entry, by SHA, in the new worktree.** A SHA names one entry however many are pushed after it:
   ```bash
   git -C '{worktree}' stash apply '{sha}'
   ```
4. **Drop the entry only once the apply is confirmed** — the changes are in the worktree's status, and any conflict the apply reported is resolved. Read the list again first: another chat may have pushed an entry since and shifted the numbers. Drop the `stash@{n}` whose message and SHA are both yours:
   ```bash
   git -C '{source}' stash list --format='%gd %H %gs'
   git -C '{source}' stash drop 'stash@{n}'
   ```

Until step 4 the entry stays in the stack, so an interruption before it loses nothing: the changes are in the worktree and still in the stash. A repository with no uncommitted changes gets no entry — `stash push` says there is nothing to save — and is skipped.

## Notes
- All repos (workspace + project repos) get the same branch name for traceability
- The task lives on this chat's record at `workspace-scratchpad/chats/{chat}.json`; the chat's in-progress designs, plans and notes live in its drawer beside it, `workspace-scratchpad/chats/{chat}/` — machine-local, which is why notes another chat needs go on the issue and `/complete-work` asks what deserves to move into `workspace-context/`
- The `workItem:` on a record's task entry holds the adapter-prefixed issue ID (e.g., `gh:42`) — the tracker itself is authoritative for status, assignment, and labels
