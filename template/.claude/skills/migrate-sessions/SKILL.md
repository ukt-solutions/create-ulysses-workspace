---
name: migrate-sessions
description: Migrate this workspace from the session lifecycle to the task lifecycle — inventory old work sessions, decide each one with the operator, drain them, and switch workspace.json to the task model. Runs only inside the current workspace.
---

# Migrate Sessions

Drain a workspace's accumulated `work-sessions/` entries and switch new work to the task lifecycle. The script is `.claude/scripts/migrate-sessions.mjs`; this skill is the operator procedure around it.

**Scope rule, before anything else: this skill acts only on the workspace it is run in.** Never read, inventory, or act on any other workspace or directory — even if asked to "do them all." Each workspace runs its own migration from its own root, by its own operator, on its own schedule.

## 1. Inventory

```bash
node .claude/scripts/migrate-sessions.mjs --inventory
```

Read-only. Present the stderr table plus each session's proposal with its reasons and warnings. Say plainly that the proposals are proposals — evidence and a starting point, not decisions.

## 2. Decide per session, with the operator — one at a time

For each session, lay out its evidence and ask the operator which way to go. Never infer the decision from the proposal. The options:

- **Finish** (typical for MERGEABLE) — resume the session with `/start-work`, then run `/complete-work`; its own merge confirmation applies there.
- **Abandon** (typical for ABANDONED or a MERGEABLE the operator gives up on) — back it up, then tear it down:
  ```bash
  node .claude/scripts/migrate-sessions.mjs --backup --session {name}
  node .claude/scripts/migrate-sessions.mjs --teardown --session {name}
  ```
  Show the tags the backup created before tearing down, and require an explicit yes that names the session. Uncommitted changes are never discarded without the operator explicitly choosing that for that session (`--discard-uncommitted` exists for exactly that choice).
- **Keep** (typical for ACTIVE) — leave it alone; it completes later under the session lifecycle.
- **Remove shell** (broken) — confirm, then let teardown remove the empty directory shell; it refuses on its own if anything but empty directories is inside.

Unbacked commits (present on no remote, flagged `unbacked` in the warnings) must be backed up before anything else happens to that session — run the backup first even if the operator already said "abandon."

## 3. Switch

```bash
node .claude/scripts/migrate-sessions.mjs --enable-task-model
```

This sets `workspace.sessionModel` to `"task"` in `workspace.json`. Commit that change on a branch through the workspace's normal PR flow — the launcher root never commits directly to its default branch. Remaining sessions are expected and fine: they keep resuming and completing under the session lifecycle after the switch.

## 4. Verify

Re-run `--inventory` and report what remains and why — kept sessions, anything the operator deferred, or an empty list.

## 5. Afterwards

The first new piece of work starts with `/start-work` under the task lifecycle.
