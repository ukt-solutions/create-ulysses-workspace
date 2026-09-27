---
name: migrate-sessions
description: Migrate this workspace from the session lifecycle to the task lifecycle — inventory old work sessions, decide each one with the operator, drain them, and switch workspace.json to the task model. Runs only inside the current workspace.
---

# Migrate Sessions

Drain a workspace's accumulated session entries and switch new work to the task lifecycle. The script is `.claude/scripts/migrate-sessions.mjs`; this skill is the operator procedure around it.

**Scope rule, before anything else: this skill acts only on the workspace it is run in.** Never read, inventory, or act on any other workspace or directory — even if asked to "do them all." Each workspace runs its own migration from its own root, by its own operator, on its own schedule.

**Run from the launcher root only** — the workspace root itself, never a session folder or any other worktree. The script refuses a linked-worktree `--root` on its own (one exception, the Switch step below), and it refuses to back up or tear down the session that hosts the current chat, so there is no way to drain the session you are sitting in from inside it.

## 1. Inventory

```bash
node .claude/scripts/migrate-sessions.mjs --inventory
```

Read-only. Present the stderr table plus each session's proposal with its reasons and warnings. Say plainly that the proposals are proposals — evidence and a starting point, not decisions. Pay particular attention to the per-remote state shown per worktree (`same`, `ahead +N`, `behind -N`, `diverged +N/-M`, `not-fetched`, `unknown`) and to `unbacked` warnings: they change what Finish and Abandon mean for that session. Entries shown as `foreign` (symlinked) are never acted on — surface them for manual reconciliation.

## 2. Decide per session, with the operator — one at a time

For each session, lay out its evidence and ask the operator which way to go. Never infer the decision from the proposal. The options:

- **Finish** (typical for MERGEABLE) — resume the session with `/start-work`, then run `/complete-work`; its own merge confirmation applies there. But if the inventory shows a **diverged** remote for that session, say so *before* the operator chooses Finish: `/complete-work`'s plain push will be rejected, and pushing the rewritten history needs `--force-with-lease` — which you run only on the operator's explicit yes naming the branch. Never force silently.
- **Abandon** (typical for ABANDONED, or a MERGEABLE the operator gives up on) — two separate decisions:
  1. **Backup is itself a decision.** It creates `drain/{session}/…` tags and pushes them to the resolved remote(s) — name the remote(s) and the tags to the operator, note that tags may land in a public repository, and ask before running `--backup --session {name}`. Show the tags it created afterward. If a repo has no remote at all, the backup refuses — the operator decides where that work goes.
  2. **Teardown after an explicit yes naming the session:** `--teardown --session {name}`. It refuses on its own until every ref it would delete is provably safe on a remote or inside a surviving ref, no worktree is dirty or mid-rebase, and the tracker agrees with disk. Before any `--discard-uncommitted` or `--discard-ignored`, show the operator the exact file list per worktree (the refusal names every path) and get an explicit yes for that session — uncommitted and ignored files are never discarded implicitly.
- **Keep** (typical for ACTIVE, and the only sane answer for UNKNOWN) — leave it; it completes later under the session lifecycle.
- **Remove shell** (broken) — confirm, then run exactly: `node .claude/scripts/migrate-sessions.mjs --teardown --session {name}` — the same teardown command; on a broken session it removes the empty directory shell and refuses on its own if anything but empty directories is inside.

Unbacked commits (present on no remote) must be backed up before anything else happens to that session — run the backup first even if the operator already said "abandon."

## 3. Switch — never write the launcher's tracked `workspace.json` directly

1. Create a workspace task worktree for the change:
   ```bash
   node .claude/scripts/task-worktree.mjs --root . --create --repo . --branch chore/enable-task-model
   ```
2. Run the switch against that worktree (the one mode that accepts a linked-worktree root — it only edits `workspace.json`):
   ```bash
   node .claude/scripts/migrate-sessions.mjs --enable-task-model --root .claude/worktrees/chore-enable-task-model
   ```
3. Commit there, open a PR through the workspace's normal flow, and pull the launcher after merge. The launcher root never commits to its default branch.

The switch output reports `remainingSessions: null` when run from the worktree — the real remaining-sessions list comes from a separate `--inventory` at the launcher root. Remaining sessions are fine either way: they keep resuming and completing under the session lifecycle after the switch.

## 4. Verify

Re-run `--inventory` at the launcher root and report what remains and why — kept sessions, anything the operator deferred, foreign entries, or an empty list.

## 5. Afterwards

The first new piece of work starts with `/start-work` under the task lifecycle.
