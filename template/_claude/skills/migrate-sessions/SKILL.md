---
name: migrate-sessions
description: Drain the work sessions a workspace still holds under the old session lifecycle. Inventory them, decide each one with the operator, finish its work through task-pr.mjs or archive it (an empty orphan shell is removed), and bring workspace.json's sessionModel in line for back-compat. Runs only inside the current workspace; the script deletes nothing but verified-empty orphan shells.
---

# Migrate Sessions

Drain the sessions a workspace still holds under the old session lifecycle. New work already starts as a task — nothing selects the lifecycle any more — so every entry under the sessions directory is work from before the task lifecycle, and this skill is how each one leaves it: landed through a pull request, or archived out of the way. The script is `.claude/scripts/migrate-sessions.mjs`; this skill is the operator procedure around it.

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

> **Quoting.** Command values go in single quotes, and a `'` inside a value is written `'\''`: chat text in double quotes would let `$(…)` or backticks run before the command starts.

For each session, lay out its evidence and ask the operator which way to go. Never infer the decision from the proposal. Every session leaves the sessions directory one of three ways:

- **Finish** (typical for MERGEABLE, and the default offer for READY_TO_COMPLETE — a session `/complete-work` stopped partway through: tracker already stripped, worktrees still live, branch often already pushed) — land the session's work with the task lifecycle's own pull-request script, `task-pr.mjs`, from **this same chat**, at the launcher. There is no resume and no `/complete-work` in it: the session's worktrees stay exactly where they are, and every git command runs in them through `--worktree`. Before the operator chooses it, say what the inventory implies:
  - A **diverged** remote means the rebase in step 3 rewrites history that remote already has, so the push will be rejected — `--force-with-lease` is run only on the operator's explicit yes naming the branch. Never force silently.
  - A `dirty` worktree (an edited `session.md` counts) has to be committed to the session branch or discarded first: the rebase, the artifact strip and the archive all need clean worktrees.
  - A worktree on a different branch than the session's (`branch-drift`, or a project worktree listed under another name) stops Finish before it starts: `task-pr.mjs` takes one branch for every repo, which is how a session is built, so the operator reconciles the branches first.

  In this chat, for the chosen session (`{session}` is its name, `{branch}` the session branch — the same name in every repo — and a `{worktree}` is the workspace worktree `work-sessions/{session}/workspace/` or a nested one under `work-sessions/{session}/workspace/repos/{repo}/`):

  1. **Goal sub-branch pre-flight** (only when a `goal-*.md` artifact is at the top of the workspace worktree). A `/goal`-driven session can produce per-phase sub-branches for code phases (any phase declaring `integration.strategy: sub-branch` in the goal artifact). They must be merged into the session branch before completion, or their work is left behind when the session is archived. Check each `{worktree}`:

     ```bash
     session_branch=$(git -C '{worktree}' rev-parse --abbrev-ref HEAD)
     for sub in $(git -C '{worktree}' branch --format='%(refname:short)' --list "${session_branch}-*"); do
       git -C '{worktree}' merge-base --is-ancestor "$sub" "$session_branch" || echo "UNMERGED: $sub"
     done
     ```

     If any `UNMERGED:` lines print, Finish stops here. The operator merges the intended sub-branches into the session branch, or closes abandoned ones, and Finish starts again. With no `goal-*.md` artifact the check is a no-op.
  2. **Decide the fate of the session artifacts.** At the top of the workspace worktree sit `session.md` and every `design-*.md`, `plan-*.md`, `goal-*.md`, `research-*.md` and `crossref-*.md`. They are the session's reasoning and its bookkeeping, and they must not land on the workspace repo's default branch. List them and offer two answers — never choose on the operator's behalf:
     - **Graduate some (the default offer).** For each artifact chosen, ask the level: team-visible `workspace-context/shared/`, or user-scoped `workspace-context/team-member/{user}/` (`shared/locked/` only if explicitly requested). Copy it into the workspace worktree under that directory, keeping the filename and making sure it carries a `description:` frontmatter (add one if it has none). Then rebuild the catalogs and commit once on the session branch, so the graduated artifacts land with the session's own workspace PR:
       ```bash
       node .claude/scripts/build-workspace-context.mjs --write --root 'work-sessions/{session}/workspace'
       git -C 'work-sessions/{session}/workspace' add workspace-context/
       git -C 'work-sessions/{session}/workspace' diff --cached --quiet || git -C 'work-sessions/{session}/workspace' commit -m 'context: graduate the artifacts of {session}'
       ```
     - **Discard.** Graduate nothing, on an explicit confirmation that names each file.

     Either way, strip them from the top of the worktree afterwards — the removal skips what is not there, and the commit is skipped when nothing is staged:

     ```bash
     git -C 'work-sessions/{session}/workspace' rm -f --ignore-unmatch -- session.md 'design-*.md' 'plan-*.md' 'goal-*.md' 'research-*.md' 'crossref-*.md'
     git -C 'work-sessions/{session}/workspace' diff --cached --quiet || git -C 'work-sessions/{session}/workspace' commit -m 'chore: remove session artifacts before PR'
     ```
  3. **Rebase each worktree onto its base**, so the PR describes the branch as it will merge: `git -C '{worktree}' fetch origin` then `git -C '{worktree}' rebase 'origin/{defaultBranch}'` for a repo with a forge remote, where `{defaultBranch}` is `repos.{repo}.branch` in `workspace.json` (default `main`) or, for the workspace repo, its origin's default branch; a local-mode repo (no origin, or `merge: "local"`) rebases onto its local `{defaultBranch}` with no fetch. If conflicts arise, STOP and present them to the operator — do not auto-resolve.
  4. **Write one PR body per forge repo, then create every PR with `task-pr.mjs --create`** — never `gh pr` directly. The repos are the session's worktrees as the inventory lists them: the workspace repo, addressed as `.`, and each nested project repo. For each one with a forge remote, write `workspace-scratchpad/migrate-pr-{session}-{repo}.md` (with `{repo}` rendered as `workspace` for `.`): a short summary of what changed and why — drawn from the tracker body, the artifacts read in step 2, the branch's commits and the linked issue — then a `## Verification` section stating how the change was checked. The scratchpad is gitignored, so these files never touch a branch. Then one command does the rest:

     ```bash
     node .claude/scripts/task-pr.mjs --create --root . --branch '{branch}' \
       --repo '.' --repo '{repo}' \
       --worktree '.=work-sessions/{session}/workspace' \
       --worktree '{repo}=work-sessions/{session}/workspace/repos/{repo}' \
       --work-item '{workItem}' \
       --body-file '.=workspace-scratchpad/migrate-pr-{session}-workspace.md' \
       --body-file '{repo}=workspace-scratchpad/migrate-pr-{session}-{repo}.md' \
       --out 'workspace-scratchpad/migrate-prs-{session}.json'
     ```

     Repeat `--repo`, `--worktree` and `--body-file` once per project repo. Omit `--work-item` when the tracker carries none or was stripped: the PR title is then the branch's first commit subject, and nothing closes an issue. `--worktree` is what tells the script where each repo's branch is checked out — it checks that each path is a worktree of that repo on `{branch}` and refuses, before pushing anything, when it is not. The rest is what any task gets. A forge repo is pushed and given one PR (a PR already open for the branch is reused, never duplicated); a local repo — no origin, or `merge: "local"` — is neither pushed nor PR'd and needs no body; a repo whose branch has no commits over its base is reported `empty` and gets nothing. If the push is rejected as non-fast-forward, ask: `--force-with-lease` is added only on the operator's explicit yes naming the branch. When the script refuses or fails, say so with its message — nothing was pushed beyond what the output shows, the session is untouched, and the same command is re-run once the cause is fixed.
  5. **Read the checks, then merge under the task's approval policy** — `task-pr.mjs --merge` also closes the linked issue:

     ```bash
     node .claude/scripts/task-pr.mjs --checks --root . --prs 'workspace-scratchpad/migrate-prs-{session}.json'
     node .claude/scripts/task-pr.mjs --merge --root . --prs 'workspace-scratchpad/migrate-prs-{session}.json' --work-item '{workItem}'
     ```

     Present a summary per repo — the PR link and its check state, the branch into its default branch — from the `--create` output and the checks. Then act on each entry's `mergeApproval` (`ask` unless `workspace.json` says `operator` for the repo): under `ask`, ask once, "Merge all? [Y/n]"; under `operator`, do not ask and do not merge — report the links and stop, adding `--approved` to the merge command only when the operator says merge in a later turn. Omit `--work-item` here too when the task has none. `--merge` reads every check before the first merge (`--wait` polls pending ones), merges the project repos first and the workspace repo last, and closes the linked issue at the end. When every repo came back `empty` there is nothing to merge: say so, leave the issue for the operator to decide, and go straight to step 6. If the operator declines or a merge fails, the session stays exactly as it is — worktrees, branches and PRs — and step 6 waits for another run of these two commands.
  6. **Archive the session** once every PR has merged (or every repo was `empty`):

     ```bash
     node .claude/scripts/migrate-sessions.mjs --archive --session '{session}'
     ```

     Expect one refusal and know its answer. A squash merge puts a new commit on the default branch and the forge deletes the branch, so the session branch's own commits are on no remote although their content is on the default branch: the archive reports them as unbacked. Show the operator the counts and say exactly that — `--allow-unbacked` is then an accurate record, and it is passed only on their explicit yes naming the session, as `node .claude/scripts/migrate-sessions.mjs --archive --session '{session}' --allow-unbacked`. A repo that merged locally fast-forwarded instead, so its branch raises no refusal. The archive moves the whole folder to `{sessions}/.archived/{session}--{timestamp}/` with every commit, file and worktree link intact: nothing is deleted, and the session stops counting as a legacy one. The archived worktrees keep the session's branches checked out, so those names stay taken until the archive is deleted. Once the operator has confirmed the merges, **the archive is safe to delete by hand**; until then it is the only checkout of the branch's own commits. Finish by deleting the PR body files and `migrate-prs-{session}.json` from the scratchpad.
- **Archive** (typical for ABANDONED, an ORPHAN_SHELL that still holds files, or a MERGEABLE the operator gives up on) — take it out of the active lifecycle without destroying anything. When the inventory shows `chat open?`, confirm with the operator that the chat is really done before offering Archive — a live chat's uncommitted work would ride into the archive unseen. Three steps, in this order, each its own decision:
  1. **Clear uncommitted work.** `--archive` refuses when any of the session's worktrees has uncommitted or untracked changes — an edited `session.md` counts — and names them, because edits buried uncommitted in an archive are invisible to every later merge or PR. Offer the operator: commit them to the session branch first (`git -C {worktree} add -A`, then `git -C {worktree} commit -m "…"` — per dirty worktree), discard them explicitly (`git -C {worktree} restore …` / `git -C {worktree} clean …`), or, on an explicit yes, re-run with `--allow-uncommitted` to archive them mid-edit. Do this before the backup: the backup tags committed tips only, so committing first brings those edits under the backup, while anything archived with `--allow-uncommitted` is NOT in it.
  2. **Offer a backup.** Archiving keeps everything on this machine; a backup adds an off-machine copy of the session's commits, and it is what makes a later deletion safe. It covers the committed tips as they stand after step 1. Plain `--backup` creates `drain/{session}/…` tags locally and pushes nothing — for a repo whose only remote is one the operator does not own, that local tag IS the backup. Pushing is a separate, explicitly allowed step:
     ```bash
     node .claude/scripts/migrate-sessions.mjs --backup --session '{name}' --remote
     ```
     With no allow flag this pushes nothing and exits non-zero, listing per repo the tag and the exact URL(s) it would push to. Approve against the push URL, not the fetch URL: a remote whose push URL differs from its fetch URL shows both, and the script refuses to push there on `--remote-allow-all` — only an explicit `--remote-allow '{repo}={remote}'` naming it proceeds. Walk the operator through every URL and ask per repo. **Never push backup tags to a remote the operator does not own — a third-party upstream, a read-only mirror, an unfamiliar push URL; pushing `drain/*` tags there publishes the session's commits somewhere foreign.** On yes for repos they do own, re-run adding `--remote-allow '{repo}={remote}'` per repo (`.` is the workspace repo; `--remote-allow-all` only when every listed URL is their own) and show what was pushed. Declining the push is fine — the archive still keeps everything locally — but the decline must be explicit: step 3's `--archive` counts what this step pushed (a tip is backed when a remote holds it on a branch or under a `drain/{session}/*` tag), so `--allow-unbacked` is needed only when the operator declined the backup — pass it only on their explicit yes naming the session, after showing them the counts.
  3. **Archive after an explicit yes naming the session:** `node .claude/scripts/migrate-sessions.mjs --archive --session '{name}'` (add `--allow-unbacked` only as the decline recorded in step 2). The whole session folder moves to `{sessions}/.archived/{name}--{timestamp}/` and git's worktree links are repaired to follow it — every commit, uncommitted edit, untracked or ignored file, and embedded repository comes along. If the move or the repair fails, the session is put back and the result says whether every link was verified. The session's branches stay checked out in the archived worktrees, so a new task cannot reuse those branch names until the archive is deleted — the result names them (`heldBranches`). The archive refuses, touching nothing, when a directory in the folder cannot be read, when the folder holds a worktree of a repository outside this workspace, when it holds a submodule checkout (its link cannot be repaired), or when a worktree tip holds commits no remote backs on a branch or under a pushed `drain/{session}/*` tag — that refusal names each repo and its commit count, exactly the backup decision step 2 deferred; it clears only when the backup pushed the tips somewhere a remote holds them, or with `--allow-unbacked`. Surface any refusal's reason; for a submodule the options are Finish, which moves nothing, or a manual reconciliation. Relay any `warnings` (relative symlinks that pointed outside the session no longer resolve after the move; a drain-tag check that did not clear, with the reason — an unreachable remote, a session name the pattern cannot express), report tips the result lists under `backedByTag` as backed by their drain tag, and when the result reports `unbacked` entries, say plainly that those commits now exist only on this machine.
- **Remove** (only an ORPHAN_SHELL the inventory marked empty — no worktree, nothing but empty directories, so there is nothing to archive). The scripted removal re-verifies emptiness itself and refuses, touching nothing, if any file or symlink has appeared since the inventory; a refusal means switch to Archive:
  ```bash
  node .claude/scripts/migrate-sessions.mjs --remove-shell --session '{name}'
  ```

A session still being worked — ACTIVE, or UNKNOWN because nothing says what it is — is neither finished nor archived on a guess. Ask the operator whether its work is at a stopping point. When it is, Finish lands what is done and the rest starts as a task. When it is not, say that the session stays for a later run and move on: nothing converts a live session to a task in place, because the lifecycles keep their state differently (a session folder with a tracker versus a branch with a chat-record entry), and no new session starts to replace it. Whatever stays is still on the drain list — the session-start hook and the maintenance audit keep counting it — until a later run finishes or archives it.

Unbacked commits (present on no remote) are safe in an archive — they are only ever at risk when someone deletes one. That is why the backup decision is a gate rather than a suggestion: the archive itself refuses until the backup step ran or the decline is recorded, and its result names what rode along.

## 3. Switch — never write the launcher's tracked `workspace.json` directly

The switch is a back-compat write, not a change of course: new work is a task whatever `workspace.json` holds, and `workspace.sessionModel` selects nothing. It brings an older file in line with the template, which ships `"task"`, and it lands the way any change to the launcher's tracked files lands. Skip it when the file already holds `"task"` — there is nothing to write.

1. Create a workspace task worktree for the change:
   ```bash
   node .claude/scripts/task-worktree.mjs --root . --create --repo . --branch chore/enable-task-model
   ```
2. Run the switch against that worktree (the one mode that accepts a linked-worktree root — it only edits `workspace.json`), passing the launcher so the remaining-session count comes back with the result:
   ```bash
   node .claude/scripts/migrate-sessions.mjs --enable-task-model --root .claude/worktrees/chore-enable-task-model --launcher .
   ```
3. Land the change the way any task lands. An `origin` on a forge (GitHub, GitLab) means a PR/MR through `task-pr.mjs` — the launcher's default branch is protected on a real forge, so landing directly on it is not an option anyway. Commit in the worktree, write a short PR body (what changed, how it was verified) to a scratch file under `workspace-scratchpad/`, and create the PR:
   ```bash
   git -C .claude/worktrees/chore-enable-task-model add workspace.json
   git -C .claude/worktrees/chore-enable-task-model commit -m "chore: record the task lifecycle in workspace.json"
   node .claude/scripts/task-pr.mjs --create --root . --branch chore/enable-task-model \
     --repo . --body-file .=workspace-scratchpad/switch-pr.md --out workspace-scratchpad/switch-prs.json
   ```
   Only a workspace whose repo has no `origin` lands locally — commit in the worktree and leave the landing to step 4. Ask git for `origin` itself (`git -C . remote get-url origin` exits non-zero when there is none) rather than listing remotes: a workspace with project clones always carries their `repo-{name}` mirrors, which are never pushed to and do not count:
   ```bash
   git -C .claude/worktrees/chore-enable-task-model add workspace.json
   git -C .claude/worktrees/chore-enable-task-model commit -m "chore: record the task lifecycle in workspace.json"
   ```
4. **Ask the operator before merging** — a step of its own, not a clause inside step 3, because a one-line diff is still the launcher's default branch and "it's only a one-line change" is not permission. Ask exactly: "The workspace.json update is ready to merge into the launcher's default branch. Merge it now?" Only an explicit yes merges; on yes:
   - `origin` is a forge remote, so Step 3 opened a PR — merge the PR, then pull the launcher:
     ```bash
     node .claude/scripts/task-pr.mjs --merge --root . --prs workspace-scratchpad/switch-prs.json
     ```
   - no `origin`, so Step 3 committed in the worktree — fast-forward the launcher's default branch, then remove the worktree:
     ```bash
     git -C . merge --ff-only chore/enable-task-model
     node .claude/scripts/task-worktree.mjs --root . --remove --repo . --branch chore/enable-task-model --delete-branch
     ```
   Either way the launcher root never commits to its default branch directly. A workspace with neither an `origin` nor a tracker completes its work in local mode: nothing is pushed and each repo merges into its own source clone — a session being finished no less than a task.

With `--launcher .` the switch output reports `remainingSessions` from the launcher even though `--root` is the switch worktree (which has no `work-sessions/` to read; without the flag the result is `remainingSessions: null` with a note pointing at a separate `--inventory` at the launcher root). Those are the sessions still to drain — step 4 lists them. Until they are, they keep resuming and completing under the session lifecycle, which stays supported for the sessions a workspace already has.

## 4. Verify

Re-run `--inventory` at the launcher root and report what remains and why — sessions the operator deferred, foreign entries, or an empty list. An empty list is the goal: once no entry is left, the session-start hook's nudge and the maintenance audit's info line both fall silent (archives under `.archived/` do not count).

## 5. Afterwards

New work starts with `/start-work` as a task, as it did before this run. What the run changed is what is left under `work-sessions/`: less of it, or none.

## Deleting an archive — the operator's call, never this skill's

Archives are meant to be kept until the operator has looked at them. When the operator asks to delete one, first show them — for the whole archive, not just its top level — everything that deletion would destroy, per worktree (list them with `git -C {repo} worktree list --porcelain` in the workspace repo and each `repos/{name}`, filtered to paths under the archive):

- commits no remote holds: `git -C {worktree} log --oneline --branches --not --remotes` and whether a `drain/*` tag covers the tip;
- uncommitted, untracked and ignored files: `git -C {worktree} status --porcelain --ignored`;
- edits hidden from status: `git -C {worktree} ls-files -v` — any lowercase tag (assume-unchanged) or `S` (skip-worktree) whose file differs from the index;
- per-worktree refs that die with the worktree: `git -C {worktree} for-each-ref refs/worktree refs/bisect`;
- an operation in progress: `MERGE_HEAD`, `rebase-merge`, `rebase-apply` under `git -C {worktree} rev-parse --git-dir`;
- embedded repositories (any `.git` directory under the archive) and their unpushed branches;
- files in the archive outside the worktrees (e.g. beside `workspace/`).

The archive of a finished session is the plain case: its work is on each repo's default branch, so what it still holds alone is the session branch's own commits — the ones a squash merge replaced — the session files, and any ignored or local files the worktrees carried. With the merges confirmed it is safe to delete; say so, and still show the list.

Only on their explicit yes naming the archive: remove the worktrees deepest-first (`git -C {repo} worktree remove --force '{path}'`), delete each branch they confirm (`git -C {repo} branch -D '{branch}'`), then delete the archive folder. Nothing in this workspace does this automatically.
