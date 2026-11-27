---
name: complete-work
description: Finalize a task — rebase, PR, merge, and close the linked issue. Handles all project repos and the workspace repo. Use when the work is done.
---

# Complete Work

Finalize the active work — a task recorded on this chat. Handles all project repos (code changes, PRs) and the workspace repo (context processing, PR). Presents a unified summary with a single merge approval, then tears down the task's worktrees and record entries.

## Flow

> **Quoting.** Command values go in single quotes, and a `'` inside a value is written `'\''`: chat text in double quotes would let `$(…)` or backticks run before the command starts.

### Step 1: Detect the task

Run task detection. A task's chat runs at the workspace root (the launcher) rather than inside a worktree, so the current directory alone cannot say which task is active:

```bash
node '{launcher-root}/.claude/scripts/task-worktree.mjs' --root '{launcher-root}' --detect --chat '{chat}'
```

- `{launcher-root}` is the absolute path on the `Workspace root:` line the SessionStart hook injects. If that line is absent, derive it from git: run `git rev-parse --git-common-dir` (when it prints a relative path, resolve it against the cwd) and take its parent directory. That derivation lands on the source clone `…/repos/{repo}` when run from inside a **project** task worktree — there the launcher is two levels up; from inside a `.` worktree (`.claude/worktrees/{slug}`) the parent already is the launcher.
- `{chat}` is the name from the `Chat record:` line the SessionStart hook injects. If that line is absent, run `node .claude/scripts/chat-record.mjs --whoami --root '{launcher-root}'` first — compaction can drop the hook line, and this recovers the name by matching the chat's session id against the records. When that too prints nothing (exit 1), omit `--chat` — detection then relies on cwd alone.
- `model: task` → go to **Task completion**. The result's `tasks` come from the chat record; if several are open, ask the user which one to complete — group by branch: a multi-repo task is several entries sharing a branch, and one issue may be open on several branches (gh:206), each its own group.
- `model: none` → "No active task. Nothing to complete." Changes sitting uncommitted on a default branch are not a task yet: `/start-work` formalizes them as one, and completion takes it from there.

## Task completion

Reached from Step 1 when detection says `model: task`. The state is the branch, the chat record's task entries, and the linked issue. This chat normally runs at the workspace root (the launcher) but may be running inside one of the worktrees; either way, every input comes from the detect result, never from cwd. Run `cd '{launcher-root}'` first — every step below and every relative path in it is anchored there:

- `{chat}` — the `Chat record:` line injected by the SessionStart hook (the same value Step 1 passed as `--chat`)
- `{tasks}` — the detect result's task entries from the chat record, each carrying `{workItem}` (null without a tracker), `{branch}`, `{repo}`; `repo: "."` is the workspace repo itself. When detection came from cwd alone (`source: 'worktree'`, no chat record entry — e.g. a chat whose record was never written) there are no task entries: take `{repo}` and `{branch}` from the detect result itself and treat `{workItem}` as absent
- `{worktree}` — `{launcher-root}/repos/{repo}/.claude/worktrees/{slug}` for a project repo, or `{launcher-root}/.claude/worktrees/{slug}` for the workspace repo (`.`), where `{slug}` is the branch with `/` replaced by `-`
- `{workspace-worktree}` — `{launcher-root}/.claude/worktrees/{slug}`: the workspace repo's own task worktree, created in step 2 only when drawer items are promoted (Claude Code's native worktree location — the two converge on it)
- `{defaultBranch}` — `workspace.json` → `repos.{repo}.branch`, default `main`; for `.` it is the workspace origin's HEAD with `main` as the fallback — or, when the launcher has no origin, the branch it sits on when that is `main`/`master` — exactly what `task-worktree.mjs`'s `defaultBranchFor` resolves
- `{mode}` per repo — `forge` or `local`, resolved exactly as `task-pr.mjs` resolves it: `local` when the repo has no origin remote or its override says so (`repos.{repo}.merge`, or `workspace.merge` for `.`) — the override for a clone whose origin is a third-party upstream nobody here may push to; `forge` when its origin is a forge remote. A local repo is never pushed: it merges into its source clone in step 4.

If several tasks are open, ask the user which one to complete — group by branch: a multi-repo task is several entries sharing a branch, and one issue may be open on several branches (gh:206), each its own group — and complete one branch at a time.

Notes meant for another chat are not drawer notes. The drawer is per-chat and machine-local — no other chat can read it, and this machine is its only copy — so nothing in it survives a handoff. Anything the next chat (or the operator, from another machine) needs to continue this task — decisions, gotchas, where work stopped — goes on the linked issue as a comment through the tracker adapter (`await tracker.comment("{workItem}", body)`), where every chat can read it.

0. **Pre-flight.** Two checks run before anything is rebased, pushed or removed, and either one stops the completion.

   **The worktrees must be clean.** For each `{worktree}` of the chosen task, `git -C '{worktree}' status --porcelain` must be empty. If it is not, stop here — before the rebase — and ask the user to commit or discard: rebasing over uncommitted work silently invalidates it.

   **Every goal sub-branch must be merged — only when a `goal-*.md` artifact is in the chat drawer.** A `/goal`-driven task can produce a per-phase sub-branch for each code phase (any phase declaring `integration.strategy: sub-branch` in the goal artifact). Those sub-branches must be merged into the task branch before completion, or their work is left on a branch nobody finishes once step 5 tears the task's worktrees and branches down. Check each `{worktree}`:

   ```bash
   task_branch=$(git -C '{worktree}' rev-parse --abbrev-ref HEAD)
   for sub in $(git -C '{worktree}' branch --format='%(refname:short)' --list "${task_branch}-*"); do
     git -C '{worktree}' merge-base --is-ancestor "$sub" "$task_branch" || echo "UNMERGED: $sub"
   done
   ```

   If any `UNMERGED:` lines print, stop and show the list. The user merges the intended sub-branches into the task branch, or closes abandoned ones, then re-runs `/complete-work`. When no `goal-*.md` artifact is in the drawer, this check is a no-op and completion proceeds normally.

1. **Rebase each task worktree onto its base** — `origin/{defaultBranch}` for a `forge` repo (`git -C '{worktree}' fetch origin`, then `git -C '{worktree}' rebase 'origin/{defaultBranch}'`), the local `{defaultBranch}` for a `local` repo (`git -C '{worktree}' rebase '{defaultBranch}'`; no fetch — there is no remote to fetch from). Freshness first: the PR in step 3 must describe the branch as it will merge. If conflicts arise, STOP and present them — do not auto-resolve.

2. **Route durable thinking.** List the chat drawer `{launcher-root}/workspace-scratchpad/chats/{chat}/` and ask which items should graduate into `workspace-context/`. The offer is filtered by task: an item whose frontmatter carries a `workItem:` is listed only when it names this task's `{workItem}`, an item with no `workItem:` is always listed, and an item tagged for another open task is not this completion's to promote — it belongs to that task's completion. Leftovers of an earlier completion attempt are never offered: the `pr-{slug}-*.md` bodies and the `prs-{slug}.json` state file are step 3–4 machinery, not thinking. Drafting skills (`/braindump`, `/handoff`, designs and plans) tag their drawer writes with `workItem:` while a task is active so this filter has something to filter on. If nothing is chosen, skip this step — no `.` worktree is needed yet. Do NOT invoke `/promote` for them: it does not know about drawer items — its sources are auto-memory, `local-only-*` files under `workspace-context/`, and `local-only-*` rules — and each of its promotions is a worktree and a PR of its own, apart from this task's. For the chosen items, first create the workspace worktree on the task's branch and record it alongside the project entries:

   ```bash
   node '{launcher-root}/.claude/scripts/task-worktree.mjs' --root '{launcher-root}' --create --repo "." --branch '{branch}'
   node '{launcher-root}/.claude/scripts/chat-record.mjs' --root '{launcher-root}' --add-task --chat '{chat}' --work-item '{workItem}' --branch '{branch}' --repo "."
   ```

   Omit `--work-item` from the record line when the task has none — without a work item the entry is keyed by repo + branch. Then copy each chosen item to `{workspace-worktree}/workspace-context/shared/{item}` or `{workspace-worktree}/workspace-context/team-member/{user}/{item}` — ask which level; `shared/locked/` only if explicitly requested — keeping the filename and making sure the file carries a `description:` frontmatter (add one if the drawer item has none). Never write under `{launcher-root}/workspace-context/` at the launcher. Rebuild the indexes and commit once, and only when something is staged:

   ```bash
   node '{launcher-root}/.claude/scripts/build-workspace-context.mjs' --write --root '{workspace-worktree}'
   git -C '{workspace-worktree}' add workspace-context/
   git -C '{workspace-worktree}' diff --cached --quiet || git -C '{workspace-worktree}' commit -m 'context: promote durable thinking for {branch}'
   ```

   The drawer is per-chat, so it survives task teardown — but it is machine-local and backed up nowhere, and this review, with the work fresh in mind, is the moment to decide what graduates. Items left behind are not lost, only unreviewed.

3. **Write one PR body per forge repo into the drawer, then create every PR with `task-pr.mjs --create`** — never `gh pr` directly. For each **forge**-mode repo of the task, `{workspace-worktree}` included when it exists, write `{launcher-root}/workspace-scratchpad/chats/{chat}/pr-{slug}-{repo}.md` (with `{repo}` rendered as `workspace` for `.`). Each body carries a short summary of what changed and why, then a `## Verification` section stating how the change was checked — the commands run and their results. The drawer is machine-local and gitignored, so these files never touch a branch; `--create` requires one for every forge repo whose branch has commits, and a local repo needs none (one given for it is accepted and ignored). Then one command does the rest:

   ```bash
   node '{launcher-root}/.claude/scripts/task-pr.mjs' --create --root '{launcher-root}' --branch '{branch}' \
     --work-item '{workItem}' --chat '{chat}' \
     --body-file '{repo}={launcher-root}/workspace-scratchpad/chats/{chat}/pr-{slug}-{repo}.md' \
     --out '{launcher-root}/workspace-scratchpad/chats/{chat}/prs-{slug}.json'
   ```

   Omit `--work-item` when the task has none, and repeat `--body-file` once per forge repo. `--chat` resolves the task's repos from this chat's record entries for the branch; when detection came from cwd alone, pass `--repo '{repo}'` once per repo instead. The script resolves each repo's merge mode before doing anything else: a forge repo is pushed `-u origin '{branch}'` and gets one PR through a per-repo forge aimed at that worktree's own origin, never the launcher's; a local repo (no origin, or `merge: "local"`) is neither pushed nor PR'd — it is recorded as a local entry for step 4. The workspace repo (`.`) is handled exactly like a project repo. It skips repos whose branch has no commits over the base (reporting them as `empty` — no push, no PR, no body file needed, torn down in step 5 like any other; a workspace branch that collected no promotions gets no PR), and stops **before pushing anything** when a repo's origin exists but is not forge-hosted and has no `"local"` override — the error names the `workspace.json` setting (`repos.{repo}.merge`, or `workspace.merge` for `.`) that opts the repo into local mode. The PR title is the linked issue's title, or the branch's first commit subject without a `{workItem}`; the body is the drawer file with `Closes <ref>` appended, where `<ref>` is `#N` when the PR's repo is the tracker's repo and `{tracker-repo}#N` otherwise — only the first form closes an issue in the PR's own repo. If the push is rejected as non-fast-forward — the branch already existed on origin and step 1's rebase rewrote it — the script stops and says so; ask the user, and only on explicit confirmation re-run the same command with `--force-with-lease` (the script never forces on its own). If `workspace.forge` is `false` in `workspace.json` and any repo resolved to forge, the script refuses before pushing anything: forge operations are disabled in this workspace and the PR is opened by hand. `--out` writes the run's JSON to `prs-{slug}.json` for step 4 — `{ prs: [{ repo, mode, … }], empty: [repo…], pushed: [repo…] }`, printed to stdout as well — instead of shell redirection, so the command is identical on every shell. Every entry carries `commits`, `worktree` (the checkout the run used) and `mergeApproval` — the repo's resolved merge-approval policy (gh:202: `repos.{repo}.mergeApproval`, or `workspace.mergeApproval` for the workspace repo `.`; `ask` when unset), which step 4 acts on; a forge entry also carries `owner`, `name`, `number`, `id`, `url` and `isWorkspace`, and a local entry `branch` and `base`. The run is idempotent: a repo whose branch already has an open PR against `{defaultBranch}` gets that PR reused, never duplicated, and if the run fails partway the file still records what was pushed and opened so far — fix the cause and re-run the same command; it completes the set.

4. **Read the checks, then merge under the task's approval policy — `task-pr.mjs --merge` also closes the linked issue.** When step 3 reported `prs: []` — every repo was empty — there is nothing to merge: skip this step, say so, and leave the linked issue open for the user to decide (close it by hand, or keep the task going); `--merge` itself refuses an empty PRs file for exactly that reason. Otherwise read every entry's CI state — the same read `--merge` gates on:

   ```bash
   node '{launcher-root}/.claude/scripts/task-pr.mjs' --checks --root '{launcher-root}' \
     --prs '{launcher-root}/workspace-scratchpad/chats/{chat}/prs-{slug}.json'
   ```

   One `{ repo, mode, state, url, failing }` per entry (a local repo reports `none` — no forge, no checks; a GitLab pipeline waiting on a manual job reports `pending` with a `note`). Present a summary per repo that got an entry — forge and local alike, the workspace repo included — built from `--create`'s output plus the check state. A local repo shows `(local merge)` in place of a PR line:

   ```
   Task complete:

   PROJECT: {owner}/{name}
     PR: {pr.url}
     Checks: {success|pending|failure|none}   # failure names its failing jobs
     Branch: {branch} → {defaultBranch}
     Commits: {n}   # from the entry's `commits` count

   PROJECT: {repo}  (local merge)
     Branch: {branch} → {defaultBranch}   # merged in repos/{repo}

   WORKSPACE: {ws-owner}/{ws-name}   # from the workspace worktree's origin, or "(local merge)"
     PR: {ws-pr.url}
     Checks: {state}
     Branch: {branch} → {defaultBranch}
   ```

   The approval policy is each entry's `mergeApproval` field (gh:202), and one `operator` entry anywhere governs the whole task — the workspace PR may never merge ahead of the project PRs it describes, so the task cannot merge part-way; a context-only PR held by its task's code PRs is the accepted limitation:

   - **ask** (the default) — ask once, after the summary: `Merge all? [Y/n]`, or `Merge all locally? [Y/n]` for an all-local task. On "n", stop: the PRs stay open and the worktrees, branches, and record entries stay in place — say so. On "y", run the merge command below.
   - **operator** — do not ask and do not merge. Report the PR links with their check states and stop there; the PRs wait. The task continues when the operator explicitly says merge in a later turn — then run the merge command below with `--approved`, which the script demands for any operator entry and which this skill passes only on that say-so — or after they merge in the forge UI, where the re-run detects the already-merged PRs, skips them (no `--approved`, no checks), and carries on to the close and the teardown. A local operator entry is done the same way: once its branch is merged into the repo's default branch — by hand or an earlier run — the re-run detects the containment and asks no approval. Keep the drawer's `prs-{slug}.json` until that run happens (it is the command's input); delete the drawer's `pr-{slug}-*.md` bodies and the spent JSON only after a successful merge.

   The merge command — on "y" under ask, or the operator's go (add `--approved`):

   ```bash
   node '{launcher-root}/.claude/scripts/task-pr.mjs' --merge --root '{launcher-root}' \
     --prs '{launcher-root}/workspace-scratchpad/chats/{chat}/prs-{slug}.json' --work-item '{workItem}'
   ```

   Before the first merge the script reads the checks of every forge PR that is not already merged — all of them up front, so the run is all-or-nothing (gh:201): any failure, or any entry still pending, stops it with every entry's state listed and nothing merged, not even the green PRs ahead of the red one — re-run once checks finish, or pass `--wait`, which polls every still-pending entry each 20-second round up to `--wait-timeout {min}` minutes (default 30, counted after the settle) and, once the last pending entry goes terminal, re-reads every entry once more so a PR that went green early and red during the wait is still caught. Checks can lag PR creation: a PR opened within the last 90 seconds that reports no checks is re-read before `none` is accepted — every such PR per round, one shared 30-second pause, twice at most — a fresh `none` may be a race rather than a verdict. `none` (no CI) and `success` proceed to the merges, in order, un-re-gated. `--skip-checks` bypasses the gate and is recorded as `checksSkipped` in the output — reach for it only on the user's say-so. Local entries skip checks: there is no forge to ask. Beyond the gate, the script finishes the project entries — forge PRs (squash, delete branch) and local branches as `git merge --ff-only '{branch}'` in the repo's source clone (`repos/{repo}`, or the launcher for `.`), which must sit clean on its default branch — then the workspace entry only when every project merge succeeded: the workspace branch's promoted context describes the project merges and must never merge ahead of them. A PR the forge already reports as merged and a local branch already contained in the default branch both count as done — and read no checks — which is what makes a re-run safe: the run that finally gets every entry merged also does the pull and the close. A local branch that will not fast-forward stops the run and says to rebase the task branch onto the local `{defaultBranch}` and re-run. The launcher is pulled `--ff-only` only when it sits on the workspace default branch, `.` was not itself merged locally (that merge ran in the launcher — `pullSkipped: "workspace merged locally"`), the workspace repo is not local (no forge merge of `.` happened that a pull could fetch — `pullSkipped: "workspace repo is local"`), and the launcher branch has an upstream to pull from (`pullSkipped: "launcher has no upstream"`); a launcher on some other branch reports `pullSkipped: "launcher on <branch>"`, and a failed pull is reported as `pullFailed: true` rather than an error, because the merges stand and the issue still closes — a failed pull is the one case that needs the launcher pulled by hand before step 5. The close comes last, with a one-line comment naming each merged PR URL or local `{repo} {branch}->{base}`: merge precedes close because an issue closed before its PR merges points at work that never landed. It happens only when `{workItem}` is given AND a tracker is configured — without a work item or without a tracker, `closed` is `null` and the JSON says why (`closeSkipped`) — say so to the user. On any merge failure the script stops, names what is still open, and exits non-zero — nothing is torn down, and re-running `--merge` once the failure is fixed is safe. After a successful merge, delete the drawer's `pr-{slug}-*.md` body files and the spent `prs-{slug}.json`.

5. **Tear down only what finished — worktree first, then the record entry**, and only for a repo whose PR merged or whose local merge succeeded in step 4, or whose branch was empty and never pushed in step 3; the workspace repo included (`--repo "."`). If a repo's push, PR, or merge failed, or the user declined the merge, leave that repo's worktree, branch, and record entry exactly in place and say so: `--delete-branch` would otherwise `branch -D` commits that exist nowhere but the local worktree. For `.` the script never deletes the branch checked out at the launcher root.

   ```bash
   node '{launcher-root}/.claude/scripts/task-worktree.mjs' --root '{launcher-root}' --remove --repo '{repo}' --branch '{branch}' --delete-branch
   node '{launcher-root}/.claude/scripts/chat-record.mjs' --root '{launcher-root}' --remove-task --chat '{chat}' --work-item '{workItem}' --branch '{branch}' --repo '{repo}'
   ```

   `--branch` is always passed: one issue may be open on several branches (gh:206), and without it the removal would take every branch of the item/repo — a sibling still in flight included. When the task has no `{workItem}`, drop `--work-item` — the entry is then keyed by repo + branch, which `--branch` selects on its own. Worktree first because a refusal (dirty worktree, slug collision) then leaves both the worktree and its record entry in place — nothing orphaned, safe to retry. `--delete-branch` also removes the local branch: the forge's `deleteBranch` removed only the remote one, so post-merge teardown passes it to clean the local clone; this is the only step that ever passes it. Never pass `--force` without asking the user.

## Notes
- All repos get PRed and merged together — one approval for all, unless a repo's `mergeApproval` says `operator` (gh:202), in which case the PRs wait for the operator's merge
- Version bumps, tags, and publish happen in `/release`, not `/complete-work` — this avoids version drift when multiple feature branches land between releases
- Teardown takes only what finished — the worktree first, then its record entry — and leaves every repo whose push, PR or merge did not complete exactly in place
- Promoting drawer items into `workspace-context/` is an intentional workflow behavior: its commit on the workspace worktree bypasses normal commit conventions by design
