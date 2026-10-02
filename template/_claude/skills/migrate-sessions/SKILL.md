---
name: migrate-sessions
description: Migrate this workspace from the session lifecycle to the task lifecycle — inventory old work sessions, decide each one with the operator, finish or archive them (empty orphan shells only: remove), and switch workspace.json to the task model. Runs only inside the current workspace; the script never deletes anything.
---

# Migrate Sessions

Drain a workspace's accumulated session entries and switch new work to the task lifecycle. The script is `.claude/scripts/migrate-sessions.mjs`; this skill is the operator procedure around it.

**Scope rule, before anything else: this skill acts only on the workspace it is run in.** Never read, inventory, or act on any other workspace or directory — even if asked to "do them all." Each workspace runs its own migration from its own root, by its own operator, on its own schedule.

**Run from the launcher root only** — the workspace root itself, never a session folder or any other worktree. The script refuses a linked-worktree `--root` on its own (one exception, the Switch step below), and it refuses to back up or archive the session that hosts the current chat, so there is no way to drain the session you are sitting in from inside it.

## 1. Inventory

```bash
node .claude/scripts/migrate-sessions.mjs --inventory
```

Read-only. Present the stderr table plus each session's proposal with its reasons and warnings. Say plainly that the proposals are proposals — evidence and a starting point, not decisions. Pay particular attention to the per-remote state shown per worktree (`same`, `ahead +N`, `behind -N`, `diverged +N/-M`, `not-fetched`, `unknown`) and to `unbacked` warnings: they change what Finish and Archive mean for that session. Each worktree also lists every configured remote with its exact URL — read those before any backup decision: `origin:none` means only that the remote holds no copy of this branch, never that the repo has no remote, and an `origin` that is really a third-party upstream shows its URL right there. Entries shown as `foreign` (symlinked) are never acted on — surface them for manual reconciliation.

Three more kinds of evidence change what you propose:

- **Fetch age** — every worktree line ends `fetch:…` with the age of its repo's last fetch, and anything over a day draws a `stale-fetch` warning: the commits-ahead and content counts ride on tracking refs frozen at that fetch. Tell the operator to fetch first, or re-run with `--inventory --fetch`, which fetches each touched source clone before inspecting it. A fetch is read-only with respect to the workspace's own state — it moves no local branch and touches no worktree, only refs/remotes/* and the object store — and a repo with no origin or an unreachable one is recorded as skipped or failed, never fatal.
- **Open chats** — `chat open?` on a session (with a `chat-open` warning) means its tracker records a chat session with no `ended:` AND the session shows activity within the active window (14 days by default) — a chat may still be working in it; confirm with the operator before proposing Archive. An open-chat entry on a session with nothing recent is a stale record, not a live chat — session-end misses often enough (a crashed chat, a skipped hook) — so it shows as `chat: no end recorded (idle {N}d)` with an informational `chat-open-idle` entry instead. Only the recent kind changes what Archive means.
- **External worktrees** — a trailing section lists worktrees the workspace's repos register outside the workspace root (a scratch checkout in tmp, a directory elsewhere). They belong to no session: nothing in this migration prunes, moves, or removes them, and you never should either — including by hand, because `git worktree prune` has no path filter and would drop their records.

## 2. Decide per session, with the operator — one at a time

For each session, lay out its evidence and ask the operator which way to go. Never infer the decision from the proposal. The options:

- **Finish** (typical for MERGEABLE, and the default offer for READY_TO_COMPLETE — a session `/complete-work` stopped partway through: tracker already stripped, worktrees still live, branch often already pushed) — finish it from **this same chat**, the launcher chat. A new chat is not needed and would not work: `/complete-work` finds a session from the launcher only when this chat's id is registered in that session's `chatSessions`, and `/start-work`'s resume flow is what registers it. In this chat:
  1. Run `/start-work` and pick the session to resume it. (A READY_TO_COMPLETE session has no tracker, and `/start-work`'s walk lists sessions by their tracker, so it will not appear — name it and re-create a minimal tracker from the inventory's `branch`/`repos` first, then resume.)
  2. Run `/complete-work` — since v0.23 it detects sessions this chat is registered on straight from the launcher, asks which to finish, and proceeds with its own merge confirmation.

  If the inventory shows a **diverged** remote for that session, say so *before* the operator chooses Finish: `/complete-work`'s plain push will be rejected, and pushing the rewritten history needs `--force-with-lease` — which you run only on the operator's explicit yes naming the branch. Never force silently.
- **Archive** (typical for ABANDONED, an ORPHAN_SHELL that still holds files, or a MERGEABLE the operator gives up on) — take it out of the active lifecycle without destroying anything. When the inventory shows `chat open?`, confirm with the operator that the chat is really done before offering Archive — a live chat's uncommitted work would ride into the archive unseen. Three steps, in this order, each its own decision:
  1. **Clear uncommitted work.** `--archive` refuses when any of the session's worktrees has uncommitted or untracked changes — an edited `session.md` counts — and names them, because edits buried uncommitted in an archive are invisible to every later merge or PR. Offer the operator: commit them to the session branch first (`git -C {worktree} add -A`, then `git -C {worktree} commit -m "…"` — per dirty worktree), discard them explicitly (`git -C {worktree} restore …` / `git -C {worktree} clean …`), or, on an explicit yes, re-run with `--allow-uncommitted` to archive them mid-edit. Do this before the backup: the backup tags committed tips only, so committing first brings those edits under the backup, while anything archived with `--allow-uncommitted` is NOT in it.
  2. **Offer a backup.** Archiving keeps everything on this machine; a backup adds an off-machine copy of the session's commits, and it is what makes a later deletion safe. It covers the committed tips as they stand after step 1. Plain `--backup` creates `drain/{session}/…` tags locally and pushes nothing — for a repo whose only remote is one the operator does not own, that local tag IS the backup. Pushing is a separate, explicitly allowed step:
     ```bash
     node .claude/scripts/migrate-sessions.mjs --backup --session {name} --remote
     ```
     With no allow flag this pushes nothing and exits non-zero, listing per repo the tag and the exact URL(s) it would push to. Approve against the push URL, not the fetch URL: a remote whose push URL differs from its fetch URL shows both, and the script refuses to push there on `--remote-allow-all` — only an explicit `--remote-allow {repo}={remote}` naming it proceeds. Walk the operator through every URL and ask per repo. **Never push backup tags to a remote the operator does not own — a third-party upstream, a read-only mirror, an unfamiliar push URL; pushing `drain/*` tags there publishes the session's commits somewhere foreign.** On yes for repos they do own, re-run adding `--remote-allow {repo}={remote}` per repo (`.` is the workspace repo; `--remote-allow-all` only when every listed URL is their own) and show what was pushed. Declining the push is fine — the archive still keeps everything locally — but the decline must be explicit: step 3's `--archive` refuses while any tip holds commits no remote backs, and proceeds only with `--allow-unbacked`, the operator's recorded no after seeing the counts.
  3. **Archive after an explicit yes naming the session:** `node .claude/scripts/migrate-sessions.mjs --archive --session {name}` (add `--allow-unbacked` only as the decline recorded in step 2). The whole session folder moves to `{sessions}/.archived/{name}--{timestamp}/` and git's worktree links are repaired to follow it — every commit, uncommitted edit, untracked or ignored file, and embedded repository comes along. If the move or the repair fails, the session is put back and the result says whether every link was verified. The session's branches stay checked out in the archived worktrees, so a new task cannot reuse those branch names until the archive is deleted. The archive refuses, touching nothing, when a directory in the folder cannot be read, when the folder holds a worktree of a repository outside this workspace, when it holds a submodule checkout (its link cannot be repaired), or when a worktree tip holds commits no remote backs — that refusal names each repo and its commit count, exactly the backup decision step 2 deferred; it clears only when a remote holds the tips (a pushed backup), or with `--allow-unbacked`. Surface any refusal's reason; for a submodule the options are Finish or Keep. Relay any `warnings` (relative symlinks that pointed outside the session no longer resolve after the move), and when the result reports `unbacked` entries, say plainly that those commits now exist only on this machine.
- **Remove** (only an ORPHAN_SHELL the inventory marked empty — no worktree, nothing but empty directories, so there is nothing to archive). The command re-verifies emptiness itself and refuses, touching nothing, if any file or symlink has appeared since the inventory; a refusal means switch to Archive:
  ```bash
  node -e "const fs=require('fs');const p=process.argv[1];const empty=d=>fs.readdirSync(d,{withFileTypes:true}).every(e=>e.isDirectory()&&empty(d+'/'+e.name));if(!empty(p)){console.error(p+' is not empty — left alone');process.exit(1)}fs.rmSync(p,{recursive:true});console.log('removed empty shell '+p)" work-sessions/{name}
  ```
- **Keep** (typical for ACTIVE, and the only sane answer for UNKNOWN) — leave it; it completes later under the session lifecycle. A kept session cannot be converted to a task in place — no converter exists, and the lifecycles keep their state differently (a session folder with a tracker vs. a branch with a chat-record entry). The supported equivalent: finish the session (merge it) and start the remaining work as a task, or keep it under the session lifecycle until it is done. Do not improvise a conversion by hand.

Unbacked commits (present on no remote) are safe in an archive — they are only ever at risk when someone deletes one. That is why the backup decision is a gate rather than a suggestion: the archive itself refuses until the backup step ran or the decline is recorded, and its result names what rode along.

## 3. Switch — never write the launcher's tracked `workspace.json` directly

The switch procedure:

1. Create a workspace task worktree for the change:
   ```bash
   node .claude/scripts/task-worktree.mjs --root . --create --repo . --branch chore/enable-task-model
   ```
2. Run the switch against that worktree (the one mode that accepts a linked-worktree root — it only edits `workspace.json`):
   ```bash
   node .claude/scripts/migrate-sessions.mjs --enable-task-model --root .claude/worktrees/chore-enable-task-model
   ```
3. Land the change the way any task lands. A forge-hosted remote (GitHub, GitLab) means a PR/MR through `task-pr.mjs` — the launcher's default branch is protected on a real forge, so landing directly on it is not an option anyway. Commit in the worktree, write a short PR body (what changed, how it was verified) to a scratch file under `workspace-scratchpad/`, then create, ask before merging, and pull the launcher after the merge:
   ```bash
   node .claude/scripts/task-pr.mjs --create --root . --branch chore/enable-task-model \
     --repo . --body-file .=workspace-scratchpad/switch-pr.md --out workspace-scratchpad/switch-prs.json
   node .claude/scripts/task-pr.mjs --merge --root . --prs workspace-scratchpad/switch-prs.json
   ```
   Only a workspace whose repo has no remote at all (`git -C . remote -v` empty) lands locally — commit in the worktree, fast-forward the launcher's default branch, remove the worktree:
   ```bash
   git -C .claude/worktrees/chore-enable-task-model add workspace.json
   git -C .claude/worktrees/chore-enable-task-model commit -m "chore: switch to the task lifecycle"
   git -C . merge --ff-only chore/enable-task-model
   node .claude/scripts/task-worktree.mjs --root . --remove --repo . --branch chore/enable-task-model --delete-branch
   ```
   Either way the launcher root never commits to its default branch directly. A workspace with neither a remote nor a tracker can use the task model's local mode (gh:173); until that ships, recommend such workspaces stay on sessions.

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
