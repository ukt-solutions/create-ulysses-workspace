---
name: complete-work
description: Finalize a work session — rebase, PR, merge, and close the linked issue. Handles all project repos and the workspace repo. Use when work on a session is done.
---

# Complete Work

Finalize the active work session. Handles all project repos (code changes, PRs) and the workspace repo (context processing, PR). Presents a unified summary with a single merge approval, then tears down the session folder.

## Flow

### Step 1: Detect context

Read the active-session pointer from `.claude/.active-session.json` in the current worktree. If it is present, this chat runs inside a session worktree: continue with this flow unchanged.

If no pointer is present, run work-model detection — this covers the task model, whose chats run at the workspace root (the launcher), not inside a worktree:

```bash
node "{launcher-root}/.claude/scripts/task-worktree.mjs" --root "{launcher-root}" --detect --chat "{chat}"
```

- `{launcher-root}` is the absolute path on the `Workspace root:` line the SessionStart hook injects. If that line is absent, derive it from git: run `git rev-parse --git-common-dir` (when it prints a relative path, resolve it against the cwd) and take its parent directory. That derivation lands on the source clone `…/repos/{repo}` when run from inside a **project** task worktree — there the launcher is two levels up; from inside a `.` worktree (`.claude/worktrees/{slug}`) the parent already is the launcher.
- `{chat}` is the name from the `Chat record:` line the SessionStart hook injects. If that line is absent, run `node .claude/scripts/chat-record.mjs --whoami --root "{launcher-root}"` first — compaction can drop the hook line, and this recovers the name by matching the chat's session id against the records. When that too prints nothing (exit 1), omit `--chat` — detection then relies on cwd alone.
- `model: session` → continue with this flow (read the session tracker as below), taking `{session-name}` from the detect result's `sessionName`.
- `model: task` → go to **Task completion (session model v2)**. The result's `tasks` come from the chat record; if several are open, ask the user which one to complete — group by branch, a multi-repo task is several entries sharing a branch.
- `model: none` → "No active work session. Nothing to complete."

Read the full session tracker at `work-sessions/{session-name}/workspace/session.md` (use the frontmatter helper in `.claude/lib/session-frontmatter.mjs` — scripts and hooks use `_utils.mjs` which wraps it).

Determine paths:
- Session folder: `work-sessions/{session-name}/`
- Workspace worktree: `work-sessions/{session-name}/workspace/`
- Project worktrees: `work-sessions/{session-name}/workspace/repos/{repo}/` for each repo in the tracker's `repos:` list
- Read each repo's default branch from workspace.json (`repos.{repo}.branch`)

### Step 2: Rebase project repos

For each repo in the tracker's `repos:`:
```bash
# {repo-branch} = repos.{repo}.branch from workspace.json
cd "work-sessions/{session-name}/workspace/repos/{repo}"
git fetch origin
git rebase "origin/{repo-branch}"
```
If conflicts arise in any repo, STOP and present them to the user. Do not auto-resolve.

### Step 3: Capture final discussion state

Run `/braindump` to capture any final discussion/reasoning to the session tracker body.
If the user declines or there's nothing to capture, skip.

### Step 4: Flush task list to session.md

Before reading sources for the PR body, flush current `TodoWrite` state to `## Tasks` per the `task-list-mirroring` rule. This ensures the body written in Step 9 sees the final state:

```bash
cd "work-sessions/{session-name}/workspace"
echo '<JSON-of-current-todos>' | node .claude/scripts/sync-tasks.mjs --write session.md
```

Mark `Complete work` as `in_progress` in the JSON before flushing — the rest of this skill IS the act of completing.

### Step 5: Gather source material

Formally read ALL sources before writing the PR body — do not summarize from memory alone:

1. **Session tracker** at `work-sessions/{session-name}/workspace/session.md` — read the full body (frontmatter is machine state, body is human content)

2. **Session-scoped specs/plans/goal artifacts** at the top of the session worktree:
   - `work-sessions/{session-name}/workspace/design-*.md` files
   - `work-sessions/{session-name}/workspace/plan-*.md` files
   - `work-sessions/{session-name}/workspace/goal-*.md` files
   - `work-sessions/{session-name}/workspace/research-*.md` files
   - `work-sessions/{session-name}/workspace/crossref-*.md` files
   - Read each one fully

3. **Handoffs** — any workspace-context entries referencing this branch:
   ```bash
   grep -rl "branch: {branch}" workspace-context/
   ```
   Read each matching file.

4. **Branch commit logs** (per repo):
   ```bash
   # For each repo in the tracker's repos list:
   cd "work-sessions/{session-name}/workspace/repos/{repo}"
   git log "origin/{repo-branch}..HEAD" --oneline
   ```

5. **The linked issue** — if the tracker has a `workItem:` field and `workspace.tracker` is configured, read the issue through the tracker adapter so the PR body can speak to what was asked.

These sources feed the PR bodies in Step 9: a short summary of what changed and why, plus a Verification section.

### Step 6: Remove session artifacts from the workspace branch

The entire `work-sessions/{session-name}/` folder is removed by the cleanup script in Step 11. Before that happens, decide what deserves to survive: the tracker, specs, plans, and goal artifacts hold the session's reasoning, and the commands below delete them from the branch.

**Goal sub-branch pre-flight (only when a `goal-*.md` artifact is present).** A `/goal`-driven session can produce per-phase sub-branches for code phases (any phase declaring `integration.strategy: sub-branch` in the goal artifact). Those sub-branches must be merged into the session branch before completion, or their work is lost when the session folder is torn down. Before stripping anything, check each repo in the session — the workspace worktree itself and every `repos/{repo}/` project worktree:

```bash
cd "work-sessions/{session-name}/workspace/repos/{repo}"   # repeat for the workspace worktree too
session_branch=$(git rev-parse --abbrev-ref HEAD)
for sub in $(git branch --format='%(refname:short)' --list "${session_branch}-*"); do
  git merge-base --is-ancestor "$sub" "$session_branch" || echo "UNMERGED: $sub"
done
```

If any `UNMERGED:` lines print, abort completion and show the list. The user merges the intended sub-branches into the session branch, or closes abandoned ones, then re-runs `/complete-work`. When no `goal-*.md` artifact is present, this check is a no-op and completion proceeds normally.

**Decide the fate of the artifacts — runs after the pre-flight, never before it.** Before stripping, list the session artifacts present at the top of the workspace worktree — `session.md` plus every `design-*.md`, `plan-*.md`, `goal-*.md`, `research-*.md`, and `crossref-*.md` — and offer two choices:

1. **Promote first (default).** Run `/promote` on the artifacts so they land in
   `workspace-context/` as durable team knowledge, then strip and continue. This is the
   right answer in every case: reasoning that is worth keeping belongs in workspace-context,
   which is where it will actually be read.
2. **Discard.** Strip anyway, with an explicit confirmation that names each file.

Never choose on the user's behalf. There is deliberately no "keep them on the branch"
option: `session.md` would merge to the workspace repo root, which is exactly the path the
next `/start-work` worktree writes its own tracker to, and `createSessionTracker` overwrites
unconditionally. Keeping artifacts on the branch does not preserve them — it contaminates
`main` and then loses them anyway on the next session.


Session content lives at the top of the workspace worktree on the session branch. Once the pre-flight passes and the artifacts' fate is decided, remove these files from the branch before the final push so main's top level stays free of session artifacts:

```bash
cd "work-sessions/{session-name}/workspace"
git rm -f session.md 2>/dev/null || true
git rm -f design-*.md 2>/dev/null || true
git rm -f plan-*.md 2>/dev/null || true
git rm -f goal-*.md 2>/dev/null || true
git rm -f research-*.md 2>/dev/null || true
git rm -f crossref-*.md 2>/dev/null || true
git commit -m "chore: remove session artifacts before PR" 2>/dev/null || true
```

The `|| true` guards keep this idempotent — if a file is already gone (e.g., a session without specs or goals), the step is a no-op. The commit is skipped when there's nothing staged.

This commit persists in the branch's history. On squash merge or rebase merge, branch history collapses to one clean commit on main with no session artifacts. On merge commits, branch history is reachable but the final tree on main shows no session content.

> **No version bump here.** Versions are bumped at release time by `/release`, which tags the merge and cuts a forge release whose notes are generated from merged PRs. `/complete-work` does not modify any project repo's `package.json`.

### Step 7: Detect remote type per repo

For each repo in the tracker's `repos:` plus the workspace repo, determine the remote type. This drives how Step 8 and Step 9 push and merge.

```bash
cd "work-sessions/{session-name}/workspace/repos/{repo}"
git remote get-url origin 2>&1
```

Classify the result:

- **GitHub remote** — URL contains `github.com` or `gh repo view` succeeds against origin → use the PR flow (Step 8a, Step 9a).
- **Local / bare remote** — URL is a filesystem path (starts with `/`, `./`, `file://`, or points at a `.git` bare mirror) → use the local merge flow (Step 8b, Step 9b).
- **Other remote** (e.g., GitLab, Bitbucket, self-hosted) — no `gh` support → fall back to the local merge flow (Step 8b, Step 9b), and mention it in the final summary.
- **No remote at all** — "No remote configured for {repo}. Want me to create one on GitHub, add an existing URL, or keep the session local (push/merge inside the local clone only)?" Act on the user's choice. Never silently skip push.

### Step 8: Push all repos

#### Step 8a: GitHub remotes

```bash
# Each project repo with a GitHub remote
cd "work-sessions/{session-name}/workspace/repos/{repo}"
git push -u origin "{branch}"

# Workspace repo — from the workspace worktree
cd "work-sessions/{session-name}/workspace"
git add .
git commit -m "chore: finalize context for {session-name}"
git push -u origin "{branch}"
```

#### Step 8b: Local/bare remotes

```bash
# Push the feature branch to the bare remote so it exists there
cd "work-sessions/{session-name}/workspace/repos/{repo}"
git push -u origin "{branch}"

# Workspace repo — same commit + push pattern
cd "work-sessions/{session-name}/workspace"
git add .
git commit -m "chore: finalize context for {session-name}"
git push -u origin "{branch}"
```

The push shape is the same as 8a — what differs is the merge mechanics in Step 9b.

### Step 9: Merge and present unified summary

#### Step 9a: GitHub remotes — create PRs, unified summary, merge

Create one PR per project repo plus one workspace PR. PR operations go through the forge adapter (`.claude/scripts/forges/interface.mjs`), not `gh` directly — see `.claude/rules/forge-operations.md` for the contract. The adapter resolves the target repo from `workspace.forge.repo` or the local git remote.

Each PR body is built from the material gathered in Step 5 — the session tracker body, the linked issue, and the commits: a short summary of what changed and why, then a **Verification** section stating how the change was checked (tests run, commands executed, results).

```javascript
import { createForge } from './.claude/scripts/forges/interface.mjs';
import { readFileSync } from 'node:fs';

const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
const forge = createForge(ws.workspace?.forge);

// For each repo in the tracker's repos with a GitHub remote, from
// work-sessions/{session-name}/workspace/repos/{repo}:
const projectPr = await forge.prCreate({
  title: `${type}: ${description}`,
  body: prBody,  // short summary + Verification section
});

// Workspace PR — from the workspace worktree:
const workspacePr = await forge.prCreate({
  title: `context: ${sessionName} work session`,
  body: workspacePrBody,
});
```

Present unified summary:
```
Work session complete:

PROJECT: {repo-1}
  PR #{n}: {type}: {description}
  Branch: {branch} → {repo-1-branch}
  Changes:
    - {bullet points from the PR body}

PROJECT: {repo-2}
  PR #{m}: {type}: {description}
  Branch: {branch} → {repo-2-branch}
  Changes:
    - {bullet points from the PR body}

WORKSPACE: {workspace-name}
  PR #{p}: context: {session-name} work session
  Branch: {branch} → main

Merge all? [Y/n]
```

If yes — merge all PRs atomically through the forge adapter:

```javascript
// For each project PR returned from Step 9a's prCreate calls:
await forge.prMerge({ id: projectPr.id, strategy: 'squash', deleteBranch: true });

// Workspace PR:
await forge.prMerge({ id: workspacePr.id, strategy: 'squash', deleteBranch: true });
```

`strategy: 'squash'` matches the workspace convention from `post-release-discipline` (`create-ulysses-workspace` requires linear history, so squash is the only strategy that merges cleanly; squash also lifts the PR body into the commit message). `deleteBranch: true` cleans the remote feature branch on success.

Then pull all repos to their default branches (still plain git):

```bash
# For each repo in the tracker's repos:
cd "repos/{repo}" && git pull origin "{repo-branch}"
cd "{main-workspace-root}" && git pull origin main
```

#### Step 9b: Local / bare / other remotes — local merge flow

No PRs are created — these remotes don't have a PR concept (or we don't have a client wired up for them). Present an adjusted summary:

```
Work session complete:

PROJECT: {repo-1}  (local remote)
  Branch: {branch} → {repo-1-branch}
  Changes:
    - {bullet points from the PR-body material}

PROJECT: {repo-2}  (local remote)
  Branch: {branch} → {repo-2-branch}
  Changes:
    - {bullet points from the PR-body material}

WORKSPACE: {workspace-name}  (local remote)
  Branch: {branch} → main

Merge all locally? [Y/n]
```

If yes — fast-forward merge on each remote, delete the feature branch, pull the source clone:
```bash
# For each repo in the tracker's repos with a local/bare remote:
cd "work-sessions/{session-name}/workspace/repos/{repo}"
git push origin "HEAD:{repo-branch}"        # fast-forward the default branch
git push origin --delete "{branch}"         # remove the feature branch from the remote
cd "repos/{repo}" && git checkout "{repo-branch}" && git pull origin "{repo-branch}"

# Workspace repo — same pattern from the workspace worktree
cd "work-sessions/{session-name}/workspace"
git push origin HEAD:main
git push origin --delete "{branch}"
cd "{main-workspace-root}" && git pull origin main
```

If the fast-forward push fails because the remote's default branch has moved ahead, STOP and present the divergence — the user decides whether to rebase and retry or handle it another way. Do not auto-resolve.

For repos with no remote at all (user chose "keep local"): skip push entirely. The branch lives only in the source clone after cleanup merges it:
```bash
cd "repos/{repo}" && git merge --ff-only "{branch}"
```

### Step 10: Close the linked issue on the tracker

If the session tracker has a `workItem:` field AND `workspace.tracker` is configured, close the linked issue via the adapter after all PRs have merged:

```javascript
import { createTracker } from './.claude/scripts/trackers/interface.mjs';
import { readFileSync } from 'node:fs';
const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
if (ws.workspace?.tracker) {
  const tracker = createTracker(ws.workspace.tracker);
  const comment = [
    `**Completed by @${currentUser}**`,
    '',
    'Merged PRs:',
    ...mergedPrs.map(p => `- ${p.repo}: ${p.url}`),
    '',
    releaseSummary, // 1-3 sentence synthesis of what shipped, drawn from the session tracker
  ].join('\n');
  await tracker.closeIssue(workItem, { comment });
}
```

If `workItem:` is unset, skip the close — this was a blank session.

If the close call fails (tracker unreachable, auth expired), report the error in the unified summary but do not block Step 11 cleanup. The issue can be closed manually via the GitHub UI; no data is at risk.

### Step 11: Cleanup

Run the cleanup helper script from the main workspace root:
```bash
node .claude/scripts/cleanup-work-session.mjs --session-name "{session-name}"
```

The script tears down in the **mandatory** order:
1. Remove each nested project worktree from its project repo
2. Remove the workspace worktree from the workspace repo
3. `git worktree prune` on each project repo (belt-and-suspenders for orphan records)
4. Delete local branches in all repos
5. `rm -rf work-sessions/{session-name}/` — the tracker, specs, plans, and any local-only artifacts vanish. Anything worth preserving was promoted into `workspace-context/` in Step 6.

Workspace-first removal silently deletes the nested project worktrees' `.git` files and leaves orphan worktree records in the project repos. The script enforces the safe order.

Verify workspace root is still on main:
```bash
git branch --show-current  # should be "main"
```

## Handling Unformal Work Sessions

If /complete-work is called but changes were made without a formal work session (no branch, changes on default branch):

Ask: "These changes weren't part of a formal work session. What do you want to do?"
- **Accept as work** — create a session retroactively, proceed with normal completion
- **Stash for later** — create a user-scoped handoff describing what was done, stash the changes
- **Hand off to someone** — create a team-visible handoff at root workspace-context/ for another member to pick up
- **Revert** — undo the changes (with confirmation)

## Task completion (session model v2)

Reached from Step 1 when detection says `model: task`. The state is the branch, the chat record's task entries, and the linked issue — there is no session folder and no `session.md`. This chat normally runs at the workspace root (the launcher) but may be running inside one of the worktrees; either way, every input comes from the detect result, never from cwd. Run `cd "{launcher-root}"` first — steps 2–5 and every relative path in them are anchored there:

- `{chat}` — the `Chat record:` line injected by the SessionStart hook (the same value Step 1 passed as `--chat`)
- `{tasks}` — the detect result's task entries from the chat record, each carrying `{workItem}`, `{branch}`, `{repo}`; `repo: "."` is the workspace repo itself. When detection came from cwd alone (`source: 'worktree'`, no chat record entry — e.g. a no-tracker task) there are no task entries: take `{repo}` and `{branch}` from the detect result itself and treat `{workItem}` as absent
- `{worktree}` — `{launcher-root}/repos/{repo}/.claude/worktrees/{slug}` for a project repo, or `{launcher-root}/.claude/worktrees/{slug}` for the workspace repo (`.`), where `{slug}` is the branch with `/` replaced by `-`
- `{workspace-worktree}` — `{launcher-root}/.claude/worktrees/{slug}`: the workspace repo's own task worktree, created in step 2 only when drawer items are promoted (Claude Code's native worktree location — the two converge on it)
- `{defaultBranch}` — `workspace.json` → `repos.{repo}.branch`, default `main`; for `.` it is the workspace origin's HEAD with `main` as the fallback — exactly what `task-worktree.mjs`'s `defaultBranchFor` resolves

If several tasks are open, ask the user which one to complete — group by branch; a multi-repo task is several entries sharing a branch — and complete one branch at a time.

0. **Pre-flight: the worktrees must be clean.** For each `{worktree}` of the chosen task, `git -C "{worktree}" status --porcelain` must be empty. If it is not, stop here — before the rebase — and ask the user to commit or discard: rebasing over uncommitted work silently invalidates it.

1. **Rebase each task worktree onto `origin/{defaultBranch}`** (`git -C "{worktree}" fetch origin`, then `git -C "{worktree}" rebase "origin/{defaultBranch}"`). Freshness first: the PR in step 3 must describe the branch as it will merge. If conflicts arise, STOP and present them — do not auto-resolve.

2. **Route durable thinking.** List the chat drawer `{launcher-root}/workspace-scratchpad/chats/{chat}/` and ask which items should graduate into `workspace-context/`. The offer is filtered by task: an item whose frontmatter carries a `workItem:` is listed only when it names this task's `{workItem}`, an item with no `workItem:` is always listed, and an item tagged for another open task is not this completion's to promote — it belongs to that task's completion. Files named `pr-*.md` are never offered: they are step 3's PR bodies, not thinking. Drafting skills (`/braindump`, `/handoff`, designs and plans) tag their drawer writes with `workItem:` while a task is active so this filter has something to filter on. If nothing is chosen, skip this step — no `.` worktree is needed yet. Do NOT invoke `/promote`: it writes relative to cwd and commits per item, which at the launcher lands on the default branch — exactly the hole this flow closes, and it does not know about drawer items. For the chosen items, first create the workspace worktree on the task's branch and record it alongside the project entries:

   ```bash
   node "{launcher-root}/.claude/scripts/task-worktree.mjs" --root "{launcher-root}" --create --repo "." --branch "{branch}"
   node "{launcher-root}/.claude/scripts/chat-record.mjs" --root "{launcher-root}" --add-task --chat "{chat}" --work-item "{workItem}" --branch "{branch}" --repo "."
   ```

   Skip the record line when there is no `{workItem}`. Then copy each chosen item to `{workspace-worktree}/workspace-context/shared/{item}` or `{workspace-worktree}/workspace-context/team-member/{user}/{item}` — ask which level; `shared/locked/` only if explicitly requested — keeping the filename and making sure the file carries a `description:` frontmatter (add one if the drawer item has none). Never write under `{launcher-root}/workspace-context/` at the launcher. Rebuild the indexes and commit once, and only when something is staged:

   ```bash
   node "{launcher-root}/.claude/scripts/build-workspace-context.mjs" --write --root "{workspace-worktree}"
   git -C "{workspace-worktree}" add workspace-context/
   git -C "{workspace-worktree}" diff --cached --quiet || git -C "{workspace-worktree}" commit -m "context: promote durable thinking for {branch}"
   ```

   The drawer is per-chat, so it survives task teardown — but it is machine-local and backed up nowhere, and this review, with the work fresh in mind, is the moment to decide what graduates. Items left behind are not lost, only unreviewed.

3. **Write one PR body per repo into the drawer, then create every PR with `task-pr.mjs --create`** — never `gh pr` directly. For each repo of the task, `{worktree}` included when it exists, write `{launcher-root}/workspace-scratchpad/chats/{chat}/pr-{slug}-{repo}.md` (with `{repo}` rendered as `workspace` for `.`). Each body carries a short summary of what changed and why, then a `## Verification` section stating how the change was checked — the commands run and their results. The drawer is machine-local and gitignored, so these files never touch a branch, and `--create` requires one for every repo whose branch has commits. Then one command does the rest:

   ```bash
   node "{launcher-root}/.claude/scripts/task-pr.mjs" --create --root "{launcher-root}" --branch "{branch}" \
     --work-item "{workItem}" --chat "{chat}" \
     --body-file "{repo}={launcher-root}/workspace-scratchpad/chats/{chat}/pr-{slug}-{repo}.md" \
     > "{launcher-root}/workspace-scratchpad/chats/{chat}/prs-{slug}.json"
   ```

   Omit `--work-item` when the task has none, and repeat `--body-file` once per repo. `--chat` resolves the task's repos from this chat's record entries for the branch; when detection came from cwd alone, pass `--repo "{repo}"` once per repo instead. The script skips repos whose branch has no commits over `origin/{defaultBranch}` (reporting them as `empty` — no push, no PR, no body file needed, torn down in step 5 like any other; a workspace branch that collected no promotions gets no PR), parses each worktree's own origin into `{owner}/{name}` and stops **before pushing anything** if any origin is not forge-hosted — such a repo is completed under the session model — then pushes `-u origin {branch}` and opens one PR per remaining repo through a per-repo forge aimed at that worktree's own remote, never the launcher's. The workspace repo (`.`) is handled exactly like a project repo. The PR title is the linked issue's title, or the branch's first commit subject without a `{workItem}`; the body is the drawer file with `Closes <ref>` appended, where `<ref>` is `#N` when the PR's repo is the tracker's repo and `{tracker-repo}#N` otherwise — only the first form closes an issue in the PR's own repo. If the push is rejected as non-fast-forward — the branch already existed on origin and step 1's rebase rewrote it — the script stops and says so; ask the user, and only on explicit confirmation re-run the same command with `--force-with-lease` (the script never forces on its own). If `workspace.forge` is `false` in `workspace.json`, the script refuses before pushing anything: forge operations are disabled in this workspace and the PR is opened by hand. Its JSON output — `{ prs: [{ repo, owner, name, number, id, url, isWorkspace }], empty: [repo…] }` — lands in `prs-{slug}.json` for step 4.

4. **Ask before merging, then run `task-pr.mjs --merge`, which also closes the linked issue.** Present a summary per repo that got a PR — the workspace repo included — built from `--create`'s output, and ask once:

   ```
   Task complete:

   PROJECT: {owner}/{name}
     PR: {pr.url}
     Branch: {branch} → {defaultBranch}
     Commits: {n}   # git -C "{worktree}" rev-list --count "origin/{defaultBranch}..{branch}"

   WORKSPACE: {ws-owner}/{ws-name}   # from the workspace worktree's origin
     PR: {ws-pr.url}
     Branch: {branch} → {defaultBranch}

   Merge all? [Y/n]
   ```

   On "n", stop: the PRs stay open and the worktrees, branches, and record entries stay in place — say so.

   On "y":

   ```bash
   node "{launcher-root}/.claude/scripts/task-pr.mjs" --merge --root "{launcher-root}" \
     --prs "{launcher-root}/workspace-scratchpad/chats/{chat}/prs-{slug}.json" --work-item "{workItem}"
   ```

   The script merges the project PRs first (squash, delete branch), then the workspace PR only when every project merge succeeded — the workspace branch's promoted context describes the project merges and must never merge ahead of them — then pulls the launcher `--ff-only` (it sat on its default branch waiting on the workspace merge; a project-only task pulls after the project merges instead) and closes the linked issue with a one-line comment naming the merged PR URL(s). Merge precedes close because an issue closed before its PR merges points at work that never landed; without a `{workItem}` (no tracker, or the task was never recorded) the close is skipped and the script says so. On any failure the script stops, names the PRs still open, and exits non-zero — nothing is torn down, and re-running `--merge` once the failure is fixed is safe. After a successful merge, delete the drawer's `pr-{slug}-*.md` body files and the spent `prs-{slug}.json`.

5. **Tear down only what finished — worktree first, then the record entry**, and only for a repo whose PR merged in step 4, or whose branch was empty and never pushed in step 3; the workspace repo included (`--repo "."`). If a repo's push, PR, or merge failed, or the user declined the merge, leave that repo's worktree, branch, and record entry exactly in place and say so: `--delete-branch` would otherwise `branch -D` commits that exist nowhere but the local worktree. For `.` the script never deletes the branch checked out at the launcher root.

   ```bash
   node "{launcher-root}/.claude/scripts/task-worktree.mjs" --root "{launcher-root}" --remove --repo "{repo}" --branch "{branch}" --delete-branch
   node "{launcher-root}/.claude/scripts/chat-record.mjs" --root "{launcher-root}" --remove-task --chat "{chat}" --work-item "{workItem}" --repo "{repo}"
   ```

   Skip the `--remove-task` line when there is no record entry (no `{workItem}`). Worktree first because a refusal (dirty worktree, slug collision) then leaves both the worktree and its record entry in place — nothing orphaned, safe to retry. `--delete-branch` also removes the local branch: the forge's `deleteBranch` removed only the remote one, so post-merge teardown passes it to clean the local clone; this is the only step that ever passes it. Never pass `--force` without asking the user.

## Notes
- The session tracker's body is the primary source for PR-body synthesis — it captures the full session history alongside specs and plans
- All repos get PRed and merged together — one approval for all
- Version bumps, tags, and publish happen in `/release`, not `/complete-work` — this avoids version drift when multiple feature branches land between releases
- The teardown order is mandatory: project worktrees first, then workspace worktree, then prune, then delete the session folder
- Context promotion and cleanup are intentional workflow behavior — they bypass normal commit conventions by design
