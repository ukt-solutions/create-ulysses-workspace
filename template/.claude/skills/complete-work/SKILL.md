---
name: complete-work
description: Finalize a work session — rebase, synthesize release notes from specs/plans/tracker/commits, create PRs with unified presentation. Handles all project repos and workspace repo. Use when work on a session is done.
---

# Complete Work

Finalize the active work session. Handles all project repos (code changes, release notes, PRs) and the workspace repo (context processing, PR). Presents a unified summary with a single merge approval.

## Flow

### Step 1: Detect context

Read the active-session pointer from `.claude-scratchpad/.active-session.json`.
If no active session: "No active work session. Nothing to complete."

Read the full session marker from the main root's `.claude-scratchpad/`.

Determine paths:
- Workspace worktree: `repos/{session-name}___wt-workspace/`
- Project worktrees: `repos/{session-name}___wt-{repo}/` for each repo in `marker.repos`
- Read each repo's branch from workspace.json (`repos.{repo}.branch`)

### Step 2: Rebase project repos

For each repo in `marker.repos`:
```bash
# {repo-branch} = repos.{repo}.branch from workspace.json
cd repos/{session-name}___wt-{repo}
git fetch origin
git rebase origin/{repo-branch}
```
If conflicts arise in any repo, STOP and present them to the user. Do not auto-resolve.

### Step 3: Capture final discussion state

Run `/braindump` to capture any final discussion/reasoning to the inflight tracker.
If the user declines or there's nothing to capture, skip.

### Step 4: Gather source material

Formally read ALL sources before synthesizing — do not write release notes from memory alone:

1. **Inflight tracker** at `shared-context/{user}/inflight/session-{session-name}.md`

2. **Branch-scoped specs/plans** in each project worktree or inflight/:
   - `design-*.md` files
   - `plan-*.md` files
   - Read each one fully

3. **Handoffs** — any shared-context entries referencing this branch:
   ```bash
   grep -rl "branch: {branch}" shared-context/
   ```
   Read each matching file.

4. **Branch commit logs** (per repo):
   ```bash
   # For each repo in marker.repos:
   cd repos/{session-name}___wt-{repo}
   git log origin/{repo-branch}..HEAD --oneline
   ```

### Step 5: Synthesize release notes

For each repo in `marker.repos` that has commits beyond the base branch:

```bash
cd repos/{session-name}___wt-{repo}
COMMIT_ID=$(git rev-parse --short HEAD)
mkdir -p release-notes/unreleased
```

**File 1: `release-notes/unreleased/branch-release-notes-{COMMIT_ID}.md`**
```markdown
---
branch: {branch}
type: {feature|fix|chore}
author: {user}
date: {YYYY-MM-DD}
---

## {Human-readable title}

{Coherent narrative synthesized from tracker + spec + plan + commits.
Written from scratch per coherent-revisions rule.}
```

**File 2: `release-notes/unreleased/branch-release-questions-{COMMIT_ID}.md`**
```markdown
---
branch: {branch}
author: {user}
date: {YYYY-MM-DD}
---

## Open Questions

{Only genuinely open questions — not things resolved during implementation.}
```

Commit per repo:
```bash
git add release-notes/unreleased/
git commit -m "docs: add release notes for {branch}"
```

If a repo has no commits beyond the base, skip release notes for it.

### Step 6: Consume branch-scoped sources

For each repo in `marker.repos`:
```bash
cd repos/{session-name}___wt-{repo}
rm -f design-*.md plan-*.md
git add -u && git commit -m "chore: remove consumed branch-scoped specs and plans"
```

Remove the inflight tracker (its content has been synthesized into release notes):
```bash
cd repos/{session-name}___wt-workspace
rm -f shared-context/{user}/inflight/session-{session-name}.md
git add -u && git commit -m "chore: consume inflight tracker for {session-name}"
```

Only consume files that are branch-scoped (in the worktree or inflight/). Leave project-scoped specs in `{user}/` ongoing.

### Step 6b: Version bump (if applicable)

For each repo in `marker.repos`, check if the repo has versioning:
```bash
cd repos/{session-name}___wt-{repo}
cat package.json 2>/dev/null | grep '"version"'
```

If no `package.json` or no `version` field: skip this repo — no versioning to manage.

If the repo has a version, determine the appropriate bump from the release notes just written:

1. Read the `type:` field from the branch release notes created in Step 5
2. Determine the bump:
   - `type: fix` or `type: chore` → **patch** (auto-bump, no confirmation needed)
   - `type: feature` → **minor** (present to user: "This session adds new functionality. Suggested bump: {current} → {next-minor}. Confirm or adjust?")
   - Breaking changes detected (schema changes, removed APIs, convention changes) → **major** (present to user: "This session includes breaking changes. Suggested bump: {current} → {next-major}. Confirm or adjust?")

3. Apply the bump:
   ```bash
   # Update version in package.json
   git add package.json
   git commit -m "chore: bump version to {new-version}"
   ```

The user can override any suggestion — they might want a patch even for a feature, or a minor even when the tool suggests patch. Accept their decision.

### Step 7: Check for no-remote

For each repo in `marker.repos`, verify remotes exist:
```bash
cd repos/{session-name}___wt-{repo}
git remote -v
```
If no remote for any repo: "No remote configured for {repo}. Want me to create one on GitHub, or provide a URL?"
Create via `gh repo create` or add the provided URL. Never silently skip push.

### Step 8: Push all repos

```bash
# Each project repo
# For each repo in marker.repos:
cd repos/{session-name}___wt-{repo}
git push -u origin {branch}

# Workspace repo
cd repos/{session-name}___wt-workspace
git add shared-context/
git commit -m "chore: finalize context for {session-name}"
git push -u origin {branch}
```

### Step 9: Create PRs and present unified summary

Create one PR per project repo plus one workspace PR:

```bash
# For each repo in marker.repos:
cd repos/{session-name}___wt-{repo}
gh pr create --title "{type}: {description}" --body "..."

# Workspace PR
cd repos/{session-name}___wt-workspace
gh pr create --title "context: {session-name} work session" --body "..."
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

If yes — merge all PRs atomically:
```bash
# For each project PR:
gh pr merge {pr-number} --merge

# Workspace PR:
gh pr merge {workspace-pr-number} --merge

# Pull all repos to their default branches
# For each repo in marker.repos:
cd repos/{repo} && git pull origin {repo-branch}
cd {main-workspace-root} && git pull origin main
```

### Step 10: Cleanup

Run the cleanup helper script from the main workspace root:
```bash
node .claude/scripts/cleanup-work-session.mjs --session-name "{session-name}"
```

This removes:
- Workspace worktree
- All project worktrees
- Local branches in all repos
- Session marker

Verify workspace root is still on main:
```bash
git branch --show-current  # should be "main"
```

## Handling Unformal Work Sessions

If /complete-work is called but changes were made without a formal work session (no branch, changes on default branch):

Ask: "These changes weren't part of a formal work session. What do you want to do?"
- **Accept as work** — create a session retroactively, proceed with normal completion
- **Stash for later** — create a user-scoped handoff describing what was done, stash the changes
- **Hand off to someone** — create a team-visible handoff at root shared-context/ for another member to pick up
- **Revert** — undo the changes (with confirmation)

## Notes
- Release notes live in the PROJECT repo worktrees — never the workspace
- The inflight tracker is the primary source for release note synthesis — it captures the full session history
- All repos get PRed and merged together — one approval for all
- Context consumption, cleanup, and auto-committing release notes are intentional workflow behavior — these bypass normal commit conventions by design
