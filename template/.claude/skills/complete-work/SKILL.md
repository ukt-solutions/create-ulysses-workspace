---
name: complete-work
description: Finalize a work session — rebase, synthesize release notes from spec/plan/session tracker/commits, create PRs with unified presentation. Handles all project repos and workspace repo. Use when work on a session is done.
---

# Complete Work

Finalize the active work session. Handles all project repos (code changes, release notes, PRs) and the workspace repo (context processing, PR). Presents a unified summary with a single merge approval, then tears down the session folder.

## Flow

### Step 1: Detect context

Read the active-session pointer from `.claude/.active-session.json` in the current worktree. If it is present, this chat runs inside a session worktree: continue with this flow unchanged.

If no pointer is present, run work-model detection — this covers the task model, whose chats run at the workspace root (the launcher), not inside a worktree:

```bash
node "{launcher-root}/.claude/scripts/task-worktree.mjs" --root "{launcher-root}" --detect --chat "{chat}"
```

- `{launcher-root}` is the absolute path on the `Workspace root:` line the SessionStart hook injects. If that line is absent, derive it from git: run `git rev-parse --git-common-dir` (when it prints a relative path, resolve it against the cwd) and take its parent directory. That derivation lands on the source clone `…/repos/{repo}` when run from inside a task worktree — there the launcher is two levels up.
- `{chat}` is the name from the `Chat record:` line the SessionStart hook injects. If that line is absent, omit `--chat` — detection then relies on cwd alone.
- `model: session` → continue with this flow (read the session tracker as below), taking `{session-name}` from the detect result's `sessionName`.
- `model: task` → go to **Task completion (session model v2)**. The result's `tasks` come from the chat record; if several are open, ask the user which one to complete — group by branch, a multi-repo task is several entries sharing a branch.
- `model: none` → "No active work session. Nothing to complete."

Read the full session tracker at `work-sessions/{session-name}/workspace/session.md` (use the frontmatter helper in `.claude/lib/session-frontmatter.mjs` — scripts and hooks use `_utils.mjs` which wraps it).

Determine paths:
- Session folder: `work-sessions/{session-name}/`
- Workspace worktree: `work-sessions/{session-name}/workspace/`
- Project worktrees: `work-sessions/{session-name}/workspace/repos/{repo}/` for each repo in the tracker's `repos:` list
- Read each repo's default branch from workspace.json (`repos.{repo}.branch`)
- **Release-notes base directory.** Read `workspace.releaseNotesDir` from `workspace.json` (default `workspace-context/release-notes` if the field is absent). Throughout this skill `{releaseNotesDir}` refers to that resolved value; every branch-note path is `{releaseNotesDir}/unreleased/{repo}/…`. Never use a bare `release-notes/`.

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

Before reading sources for synthesis, flush current `TodoWrite` state to `## Tasks` per the `task-list-mirroring` rule. This ensures the synthesis in Step 6 sees the final state:

```bash
cd "work-sessions/{session-name}/workspace"
echo '<JSON-of-current-todos>' | node .claude/scripts/sync-tasks.mjs --write session.md
```

Mark `Complete work` as `in_progress` in the JSON before flushing — the rest of this skill IS the act of completing.

### Step 5: Gather source material

Formally read ALL sources before synthesizing — do not write release notes from memory alone:

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

### Step 6: Synthesize release notes

Branch notes are written to the **workspace** repo, not the project repo. They are an internal retrospection artifact consumed by `/release` at release time; the project repo only ever receives a `CHANGELOG.md` entry. This separation keeps dogfood content out of public project repos between feature merge and the next release cut.

For each repo in the tracker's `repos:` list that has commits beyond the base branch:

```bash
cd "work-sessions/{session-name}/workspace/repos/{repo}"
COMMIT_ID=$(git rev-parse --short HEAD)
cd ../..  # back to the workspace worktree
mkdir -p "{releaseNotesDir}/unreleased/{repo-name}"
```

**File 1: `{releaseNotesDir}/unreleased/{repo-name}/branch-release-notes-{COMMIT_ID}.md`** (relative to the workspace worktree)
```markdown
---
branch: {branch}
repo: {repo-name}
type: {feature|fix|chore}
author: {user}
date: {YYYY-MM-DD}
---

## {Human-readable title}

{Coherent narrative synthesized from tracker + spec + plan + commits.
Written from scratch per coherent-revisions rule.}
```

**File 2: `{releaseNotesDir}/unreleased/{repo-name}/branch-release-questions-{COMMIT_ID}.md`**
```markdown
---
branch: {branch}
repo: {repo-name}
author: {user}
date: {YYYY-MM-DD}
---

## Open Questions

{Only genuinely open questions — not things resolved during implementation.}
```

The `repo:` frontmatter field is what `/release` uses to know which project repo's `CHANGELOG.md` should consume each note. The directory name is the same as the field for redundancy.

After all repos are processed, commit once on the workspace branch:
```bash
cd "work-sessions/{session-name}/workspace"
git add "{releaseNotesDir}/unreleased/"
git commit -m "docs: add release notes for {branch}"
```

If a repo has no commits beyond the base, skip release notes for it.

**Count what you wrote.** Keep track of how many branch-note files Step 6 produced. Notes
are written only for repos in the tracker's `repos:` list, so a session whose changes are
entirely in the workspace repo — research, context, documentation, or workspace code such as
hooks and scripts — matches no project repo and produces **zero** notes. That count is the
guard Step 7 depends on.

### Step 7: Remove session artifacts from the workspace branch

The entire `work-sessions/{session-name}/` folder is removed by the cleanup script in Step 12. Before that happens, make sure everything worth preserving has landed in release notes (Step 6) — once Step 6 has run, the tracker, specs, plans, and goal artifacts have served their purpose.

**Goal sub-branch pre-flight (only when a `goal-*.md` artifact is present).** A `/goal`-driven session can produce per-phase sub-branches for code phases (any phase declaring `integration.strategy: sub-branch` in the goal artifact). Those sub-branches must be merged into the session branch before completion, or their work is lost when the session folder is torn down. Before stripping anything, check each repo in the session — the workspace worktree itself and every `repos/{repo}/` project worktree:

```bash
cd "work-sessions/{session-name}/workspace/repos/{repo}"   # repeat for the workspace worktree too
session_branch=$(git rev-parse --abbrev-ref HEAD)
for sub in $(git branch --format='%(refname:short)' --list "${session_branch}-*"); do
  git merge-base --is-ancestor "$sub" "$session_branch" || echo "UNMERGED: $sub"
done
```

If any `UNMERGED:` lines print, abort completion and show the list. The user merges the intended sub-branches into the session branch, or closes abandoned ones, then re-runs `/complete-work`. When no `goal-*.md` artifact is present, this check is a no-op and completion proceeds normally.

**Zero-notes guard — runs after the pre-flight, never before it.** When Step 6 wrote zero
branch-note files, nothing this session produced has been archived, and the next commands
delete the artifacts. Stop and report before stripping.

The right message depends on where the session's work actually lives, so check first:

```bash
cd "work-sessions/{session-name}/workspace"
git log origin/main..HEAD --oneline -- . ':(exclude)session.md' ':(exclude)design-*.md' \
  ':(exclude)plan-*.md' ':(exclude)goal-*.md' ':(exclude)research-*.md' ':(exclude)crossref-*.md'
```

- **Commits listed** — the session changed workspace-repo files (hooks, scripts, rules,
  context). That work merges normally and is not at risk. What the strip would lose is the
  reasoning in `session.md` and any specs or plans: why the change was made, what was
  rejected, what remains open.
- **No commits listed** — the artifacts *are* the deliverable. Research, design, or context
  work with nothing else to merge. Stripping deletes the session's entire output.

Report which case applies, name the files that would be removed, then offer two choices:

1. **Promote first (default).** Run `/promote` on the artifacts so they land in
   `workspace-context/` as durable team knowledge, then strip and continue. This is the
   right answer in both cases: reasoning that is worth keeping belongs in workspace-context,
   which is where it will actually be read.
2. **Discard.** Strip anyway, with an explicit confirmation that names each file.

Never choose on the user's behalf. There is deliberately no "keep them on the branch"
option: `session.md` would merge to the workspace repo root, which is exactly the path the
next `/start-work` worktree writes its own tracker to, and `createSessionTracker` overwrites
unconditionally. Keeping artifacts on the branch does not preserve them — it contaminates
`main` and then loses them anyway on the next session.


Session content lives at the top of the workspace worktree on the session branch. Once the pre-flight passes, remove these files from the branch before the final push so main's top level stays free of session artifacts:

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

> **No version bump here.** Versions are bumped at release time by `/release`, which consumes accumulated unreleased branch notes into a single `CHANGELOG.md` entry per project repo. `/complete-work` only writes branch notes; it does not modify any project repo's `package.json`. This avoids version drift when multiple feature branches land between releases.

### Step 8: Detect remote type per repo

For each repo in the tracker's `repos:` plus the workspace repo, determine the remote type. This drives how Step 9 and Step 10 push and merge.

```bash
cd "work-sessions/{session-name}/workspace/repos/{repo}"
git remote get-url origin 2>&1
```

Classify the result:

- **GitHub remote** — URL contains `github.com` or `gh repo view` succeeds against origin → use the PR flow (Step 9a, Step 10a).
- **Local / bare remote** — URL is a filesystem path (starts with `/`, `./`, `file://`, or points at a `.git` bare mirror) → use the local merge flow (Step 9b, Step 10b).
- **Other remote** (e.g., GitLab, Bitbucket, self-hosted) — no `gh` support → fall back to the local merge flow (Step 9b, Step 10b), and mention it in the final summary.
- **No remote at all** — "No remote configured for {repo}. Want me to create one on GitHub, add an existing URL, or keep the session local (push/merge inside the local clone only)?" Act on the user's choice. Never silently skip push.

### Step 9: Push all repos

#### Step 9a: GitHub remotes

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

#### Step 9b: Local/bare remotes

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

The push shape is the same as 9a — what differs is the merge mechanics in Step 10b.

### Step 10: Merge and present unified summary

#### Step 10a: GitHub remotes — create PRs, unified summary, merge

Create one PR per project repo plus one workspace PR. PR operations go through the forge adapter (`.claude/scripts/forges/interface.mjs`), not `gh` directly — see `.claude/rules/forge-operations.md` for the contract. The adapter resolves the target repo from `workspace.forge.repo` or the local git remote.

```javascript
import { createForge } from './.claude/scripts/forges/interface.mjs';
import { readFileSync } from 'node:fs';

const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
const forge = createForge(ws.workspace?.forge);

// For each repo in the tracker's repos with a GitHub remote, from
// work-sessions/{session-name}/workspace/repos/{repo}:
const projectPr = await forge.prCreate({
  title: `${type}: ${description}`,
  body: prBody,  // synthesized release notes + verification section
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
    - {bullet points from release notes}
  Release notes: branch-release-notes-{COMMIT_ID}.md

PROJECT: {repo-2}
  PR #{m}: {type}: {description}
  Branch: {branch} → {repo-2-branch}
  Changes:
    - {bullet points from release notes}

WORKSPACE: {workspace-name}
  PR #{p}: context: {session-name} work session
  Branch: {branch} → main

Merge all? [Y/n]
```

If yes — merge all PRs atomically through the forge adapter:

```javascript
// For each project PR returned from Step 10a's prCreate calls:
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

**Step 10a.1: Tag the merge commit (release sessions only, project repos with `package.json`)**

The next three sub-substeps run only when the session branch starts with `release/` — the convention for release sessions (e.g., `release/v0.15.0-beta.0`). For feature, bugfix, and chore sessions, skip 10a.1, 10a.2, and 10a.3 entirely; non-release sessions don't trigger publishes. Detection is purely by branch prefix.

Derive the version tag from the branch name by stripping the `release/` prefix (so `release/v0.15.0-beta.0` yields `v0.15.0-beta.0`). For each project repo whose `package.json` declares a `version` field, verify that version matches the derived tag. The workspace repo is **never** tagged — only project repos with publishable `package.json` files get tagged, since the tag triggers `.github/workflows/publish.yml` in that project repo. If a project repo's `package.json` version doesn't match the release tag, skip that repo with a warning rather than failing the whole completion flow — the mismatch usually means `/release` was run against a different version than the branch name suggests, and the user needs to investigate before publishing.

Before tagging, preflight against origin: if `v{version}` already exists remotely, surface the conflict to the user with three explicit recovery options — **Reuse** (skip to 10a.2 if the existing tag points at the right commit), **Replace** (`git push origin --delete v{version}` then re-run 10a.1), or **Investigate** (`forge.releaseView({ tag: 'v{version}', repo: '{org}/{repo}' })` — or `gh release view v{version}` as a manual fallback — to see what shipped). Do **not** silently force-push the tag; an existing tag means a published artifact, and overwriting it without confirmation can corrupt the npm registry's view of the release history.

If the tag is absent on origin, tag the merge commit (HEAD on `{default-branch}` after the prior `git pull origin {default-branch}`) and push the tag. The tag push triggers `.github/workflows/publish.yml`.

```bash
# Detect: only run for release sessions.
if [[ ! "$branch" =~ ^release/ ]]; then
  # Not a release session — skip 10a.1, 10a.2, 10a.3.
  return
fi

# Extract the version from the branch name (release/v{X} → v{X}).
version_tag="${branch#release/}"   # e.g. "v0.15.0-beta.0"

# For each project repo with a package.json containing a version field:
for repo in {project-repos-with-package-json}; do
  cd "repos/{repo}"

  # Verify package.json version matches the tag.
  pkg_version=$(node -p "require('./package.json').version")
  expected_version="${version_tag#v}"
  if [ "$pkg_version" != "$expected_version" ]; then
    echo "Skipping {repo}: package.json version ($pkg_version) does not match release tag ($expected_version)."
    continue
  fi

  # Preflight: does the tag already exist on origin?
  if git ls-remote --exit-code origin "refs/tags/$version_tag" >/dev/null 2>&1; then
    # Tag exists. Surface to user with three options:
    # 1. Reuse — skip to 10a.2 if the existing tag points at the right commit.
    # 2. Replace — `git push origin --delete $version_tag` then re-run 10a.1.
    # 3. Investigate — call forge.releaseView({ tag: '$version_tag' }) — or
    #    `gh release view $version_tag` as a manual fallback — to see what shipped.
    # Do NOT silently force-push.
    echo "Tag $version_tag already exists on origin. Aborting with recovery options."
    return 1
  fi

  # Tag the merge commit (HEAD on default branch after the prior `git pull`).
  git tag "$version_tag"
  git push origin "$version_tag"   # Triggers .github/workflows/publish.yml
done
```

**Step 10a.2: Watch the publish workflow (release sessions only)**

For each project repo tagged in 10a.1, find and follow the `publish.yml` workflow run on GitHub. The workflow takes a moment to register against the new tag — poll up to 5 times with a 3-second backoff before giving up. Once the run is found, attach with `workflowRunWatch` so the maintainer sees progress live alongside the unified summary. The adapter's `exitStatus: true` makes the underlying `gh run watch --exit-status` exit non-zero on workflow failure; the adapter returns the exit code via `res.exitCode` instead of throwing, so a failure does **not** abort the rest of `/complete-work` — the maintainer still needs to see the unified summary, including the failure URL, to decide whether to rerun, redo the release, or roll the tag back. If no run registers within the retry window, log a warning with the manual investigation command and continue.

```javascript
import { createForge } from './.claude/scripts/forges/interface.mjs';
import { readFileSync } from 'node:fs';

const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
const forge = createForge(ws.workspace?.forge);

// Retry up to 5 times with 3-second backoff — the run takes a moment to register.
let run = null;
for (let i = 0; i < 5; i++) {
  run = await forge.workflowRunFind({
    workflow: 'publish.yml',
    branch: versionTag,        // e.g. 'v0.15.0-beta.0'
    repo: `${org}/${repo}`,
    limit: 1,
  });
  if (run) break;
  await new Promise(r => setTimeout(r, 3000));
}

if (!run) {
  console.warn(`Warning: no publish workflow run found for ${versionTag} after 15s. Investigate via 'gh run list --workflow publish.yml --branch ${versionTag}'.`);
} else {
  const result = await forge.workflowRunWatch({
    runId: run.runId,
    repo: `${org}/${repo}`,
    exitStatus: true,
  });
  // result.exitCode === 0 on success; non-zero on workflow failure (NOT thrown).
  // result.exitCode and run.url feed into the unified summary in Step 10a.3.
}
```

**Step 10a.3: Update the unified summary (release sessions only)**

The unified summary block presented earlier in Step 10a already has a section per project repo. For release sessions, append a `PUBLISH` section per tagged project repo to the same summary — this goes inside the existing summary, not in a new location, so the maintainer sees one consolidated report covering merges, tags, and npm publishes:

```
PUBLISH ({repo}):
  Tag: v{version}
  Workflow: {run-url}
  Status: success | failure
  Published: {dist-tag}@{version} on npm
```

Pull `Status` from the watch result's `exitCode` (success when `result.exitCode === 0`, failure otherwise). Pull `Workflow` from `run.url` captured in 10a.2. Pull `Published: {dist-tag}@{version}` from the workflow's published-package output if available; if the workflow failed before publishing, omit the `Published:` line and rely on `Status: failure` plus the workflow URL to point the maintainer at the failure.

#### Step 10b: Local / bare / other remotes — local merge flow

No PRs are created — these remotes don't have a PR concept (or we don't have a client wired up for them). Present an adjusted summary:

```
Work session complete:

PROJECT: {repo-1}  (local remote)
  Branch: {branch} → {repo-1-branch}
  Changes:
    - {bullet points from release notes}
  Release notes: branch-release-notes-{COMMIT_ID}.md

PROJECT: {repo-2}  (local remote)
  Branch: {branch} → {repo-2-branch}
  Changes:
    - {bullet points from release notes}

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

### Step 11: Close the linked issue on the tracker

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
    releaseSummary, // 1-3 sentence synthesis of what shipped, drawn from release notes
  ].join('\n');
  await tracker.closeIssue(workItem, { comment });
}
```

If `workItem:` is unset, skip the close — this was a blank session.

If the close call fails (tracker unreachable, auth expired), report the error in the unified summary but do not block Step 12 cleanup. The issue can be closed manually via the GitHub UI; no data is at risk.

### Step 12: Cleanup

Run the cleanup helper script from the main workspace root:
```bash
node .claude/scripts/cleanup-work-session.mjs --session-name "{session-name}"
```

The script tears down in the **mandatory** order:
1. Remove each nested project worktree from its project repo
2. Remove the workspace worktree from the workspace repo
3. `git worktree prune` on each project repo (belt-and-suspenders for orphan records)
4. Delete local branches in all repos
5. `rm -rf work-sessions/{session-name}/` — the tracker, specs, plans, and any local-only artifacts vanish. Their content was already archived into release notes in Step 6.

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

Reached from Step 1 when detection says `model: task`. The state is the branch, the chat record's task entries, and the linked issue — there is no session folder and no `session.md`. This chat runs at the workspace root (the launcher), so every input comes from the detect result, never from cwd:

- `{chat}` — the `Chat record:` line injected by the SessionStart hook (the same value Step 1 passed as `--chat`)
- `{tasks}` — the detect result's task entries from the chat record, each carrying `{workItem}`, `{branch}`, `{repo}`. When detection came from cwd alone (`source: 'worktree'`, no chat record entry — e.g. a no-tracker task) there are no task entries: take `{repo}` and `{branch}` from the detect result itself and treat `{workItem}` as absent
- `{worktree}` — `{launcher-root}/repos/{repo}/.claude/worktrees/{slug}`, where `{slug}` is the branch with `/` replaced by `-`
- `{defaultBranch}` — `workspace.json` → `repos.{repo}.branch`, default `main`

If several tasks are open, ask the user which one to complete — group by branch; a multi-repo task is several entries sharing a branch — and complete one branch at a time.

0. **Pre-flight: the worktrees must be clean.** For each `{worktree}` of the chosen task, `git -C "{worktree}" status --porcelain` must be empty. If it is not, stop here — before the rebase — and ask the user to commit or discard: rebasing over uncommitted work silently invalidates it.

1. **Rebase each task worktree onto `origin/{defaultBranch}`** (`git -C "{worktree}" fetch origin`, then `git -C "{worktree}" rebase "origin/{defaultBranch}"`). Freshness first: the PR in step 4 must describe the branch as it will merge. If conflicts arise, STOP and present them — do not auto-resolve.

2. **Route durable thinking.** List anything in the chat drawer `workspace-scratchpad/chats/{chat}/` and ask which items to `/promote` into `workspace-context/`. The drawer is per-chat, so it survives task teardown — but it is machine-local and backed up nowhere, and this review, with the work fresh in mind, is the moment to decide what graduates. Items left behind are not lost, only unreviewed.

3. **Release notes: not supported on this path yet.** If `workspace.publishes` is `true` in `workspace.json`, STOP and tell the user: release-note synthesis writes into a workspace-repo branch, and the task model has no workspace-repo worktree — complete this work under the session model (`workspace.sessionModel: "session"`) instead, or write the notes manually in a workspace-repo branch. If `workspace.publishes` is not set, skip and say it was skipped.

4. **Push and open one PR per repo, through the forge adapter** — never `gh pr` directly. The chat runs at the launcher, where a bare `createForge()` resolves the workspace repo and the launcher's branch, so the forge is constructed per repo and aimed at that worktree's own origin:

   ```bash
   git -C "{worktree}" push -u origin "{branch}"
   git -C "{worktree}" remote get-url origin   # → parse {owner}/{name} from this URL
   ```

   If the push is rejected as non-fast-forward — the branch already existed on origin and step 1 rebased it — ask the user before retrying with `git -C "{worktree}" push --force-with-lease`. Never force without asking.

   If a repo's origin does not parse into `{owner}/{name}` (a local/bare remote) or is a forge the adapter does not support, STOP: the task path supports forge-hosted repos only in this stage — complete that repo under the session model.

   ```javascript
   import { createForge } from './.claude/scripts/forges/interface.mjs';
   import { readFileSync } from 'node:fs';
   const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
   // Constructed per repo, so the adapter never resolves the launcher's own remote.
   const forge = createForge({ ...ws.workspace?.forge, repo: '{owner}/{name}' });
   const pr = await forge.prCreate({
     title: `${type}: ${description}`,
     body: prBody,
     head: '{branch}',
     base: '{defaultBranch}',
   });
   ```

5. **Merge, then close the linked issue.** Merge through the same per-repo forge (merge must precede close — an issue closed before its PR merges points at work that never landed):

   ```javascript
   await forge.prMerge({ id: pr.id, strategy: 'squash', deleteBranch: true });
   ```

   Then close the linked issue with the same `createTracker(ws.workspace.tracker)` + `tracker.closeIssue(workItem, { comment })` call Step 11 uses — only if a `{workItem}` exists. Without one (no tracker, or the task was never recorded), skip the close and say so.

6. **Tear down: worktree first, then the record entry**, per repo of the task:

   ```bash
   node "{launcher-root}/.claude/scripts/task-worktree.mjs" --root "{launcher-root}" --remove --repo "{repo}" --branch "{branch}" --delete-branch
   node "{launcher-root}/.claude/scripts/chat-record.mjs" --root "{launcher-root}" --remove-task --chat "{chat}" --work-item "{workItem}" --repo "{repo}"
   ```

   Skip the `--remove-task` line when there is no record entry (no `{workItem}`). Worktree first because a refusal (dirty worktree, slug collision) then leaves both the worktree and its record entry in place — nothing orphaned, safe to retry. `--delete-branch` also removes the local branch: the forge's `deleteBranch` removed only the remote one, so post-merge teardown passes it to clean the local clone; this is the only step that ever passes it. Never pass `--force` without asking the user.

The release-branch publish sub-steps (10a.1–10a.3) are out of scope for the task path in this stage.

## Notes
- Branch release notes live in the WORKSPACE repo at `{releaseNotesDir}/unreleased/{repo-name}/` (resolved from `workspace.json` → `workspace.releaseNotesDir`, default `workspace-context/release-notes`) — never in project repos. Project repos only ever see code commits and (at release time) `CHANGELOG.md` entries written by `/release`.
- The session tracker's body is the primary source for release note synthesis — it captures the full session history alongside specs and plans
- All repos get PRed and merged together — one approval for all
- Version bumps happen in `/release`, not `/complete-work` — this avoids version drift when multiple feature branches land between releases
- The teardown order is mandatory: project worktrees first, then workspace worktree, then prune, then delete the session folder
- Context consumption, cleanup, and auto-committing release notes are intentional workflow behavior — these bypass normal commit conventions by design
