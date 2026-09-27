---
name: migrate-sessions
description: Migrate this workspace from the session lifecycle to the task lifecycle — inventory old work sessions, decide each one with the operator, finish or archive them, and switch workspace.json to the task model. Runs only inside the current workspace; never deletes anything.
---

# Migrate Sessions

Drain a workspace's accumulated session entries and switch new work to the task lifecycle. The script is `.claude/scripts/migrate-sessions.mjs`; this skill is the operator procedure around it.

**Scope rule, before anything else: this skill acts only on the workspace it is run in.** Never read, inventory, or act on any other workspace or directory — even if asked to "do them all." Each workspace runs its own migration from its own root, by its own operator, on its own schedule.

**Run from the launcher root only** — the workspace root itself, never a session folder or any other worktree. The script refuses a linked-worktree `--root` on its own (one exception, the Switch step below), and it refuses to back up or archive the session that hosts the current chat, so there is no way to drain the session you are sitting in from inside it.

## 1. Inventory

```bash
node .claude/scripts/migrate-sessions.mjs --inventory
```

Read-only. Present the stderr table plus each session's proposal with its reasons and warnings. Say plainly that the proposals are proposals — evidence and a starting point, not decisions. Pay particular attention to the per-remote state shown per worktree (`same`, `ahead +N`, `behind -N`, `diverged +N/-M`, `not-fetched`, `unknown`) and to `unbacked` warnings: they change what Finish and Archive mean for that session. Entries shown as `foreign` (symlinked) are never acted on — surface them for manual reconciliation.

## 2. Decide per session, with the operator — one at a time

For each session, lay out its evidence and ask the operator which way to go. Never infer the decision from the proposal. The options:

- **Finish** (typical for MERGEABLE) — resume the session with `/start-work`, then run `/complete-work`; its own merge confirmation applies there. But if the inventory shows a **diverged** remote for that session, say so *before* the operator chooses Finish: `/complete-work`'s plain push will be rejected, and pushing the rewritten history needs `--force-with-lease` — which you run only on the operator's explicit yes naming the branch. Never force silently.
- **Archive** (typical for ABANDONED, a broken shell, or a MERGEABLE the operator gives up on) — take it out of the active lifecycle without destroying anything. Two steps, each its own decision:
  1. **Offer a backup.** Archiving keeps everything on this machine; a backup adds an off-machine copy of the session's commits, and it is what makes a later deletion safe. It creates `drain/{session}/…` tags and pushes them to the resolved remote(s) — tags may land in a public repository, so show the plan first: `node .claude/scripts/migrate-sessions.mjs --backup --session {name} --dry-run` (add `--remote <name>` to aim somewhere other than the resolved default). It lists, per tip, the tag, the remote, and which tips a remote branch or tag already holds exactly, with no side effects. On the operator's yes, run it without `--dry-run` and show the tags it created. Declining is fine — the archive still keeps everything locally. A repo with no remote at all is refused by backup; say so.
  2. **Archive after an explicit yes naming the session:** `node .claude/scripts/migrate-sessions.mjs --archive --session {name}`. The whole session folder moves to `{sessions}/.archived/{name}--{timestamp}/` and git's worktree links are repaired to follow it — every commit, uncommitted edit, untracked or ignored file, and embedded repository comes along. If the move or the repair fails, the session is put back and the result says whether every link was verified. The session's branches stay checked out in the archived worktrees, so a new task cannot reuse those branch names until the archive is deleted. The archive refuses, touching nothing, when a directory in the folder cannot be read, when the folder holds a worktree of a repository outside this workspace, or when it holds a submodule checkout (its link cannot be repaired) — surface the reason; for a submodule the options are Finish or Keep. Relay any `warnings` (relative symlinks that pointed outside the session no longer resolve after the move).
- **Keep** (typical for ACTIVE, and the only sane answer for UNKNOWN) — leave it; it completes later under the session lifecycle.

Unbacked commits (present on no remote) are safe in an archive — they are only ever at risk when someone deletes one. Say so when you archive such a session, and offer the backup.

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

## Deleting an archive — the operator's call, never this skill's

Archives are meant to be kept until the operator has looked at them. When the operator asks to delete one, first show them — for the whole archive, not just its top level — everything that deletion would destroy, per worktree (list them with `git -C {repo} worktree list --porcelain` in the workspace repo and each `repos/{name}`, filtered to paths under the archive):

- commits no remote holds: `git -C {worktree} log --oneline --branches --not --remotes` and whether a `drain/*` tag covers the tip;
- uncommitted, untracked and ignored files: `git -C {worktree} status --porcelain --ignored`;
- edits hidden from status: `git -C {worktree} ls-files -v` — any lowercase tag (assume-unchanged) or `S` (skip-worktree) whose file differs from the index;
- per-worktree refs that die with the worktree: `git -C {worktree} for-each-ref refs/worktree refs/bisect`;
- an operation in progress: `MERGE_HEAD`, `rebase-merge`, `rebase-apply` under `git -C {worktree} rev-parse --git-dir`;
- embedded repositories (any `.git` directory under the archive) and their unpushed branches;
- files in the archive outside the worktrees (e.g. beside `workspace/`).

Only on their explicit yes naming the archive: remove the worktrees deepest-first (`git -C {repo} worktree remove --force {path}`), delete each branch they confirm (`git -C {repo} branch -D {branch}`), then delete the archive folder. Nothing in this workspace does this automatically.
