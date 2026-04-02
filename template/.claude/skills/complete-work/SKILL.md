---
name: complete-work
description: Finalize a branch — rebase, synthesize release notes from specs/plans/handoffs/commits, create PR. Handles both project repo and workspace repo. Use when work on a branch is done.
---

# Complete Work

Finalize the current branch. Handles both the project repo (code changes, release notes, PR) and the workspace repo (context processing, push, PR).

## Flow

### Step 1: Detect context

Determine the current state across both repos:

**Project repo:**
```bash
# Find the active worktree and branch
git -C repos/{repo} worktree list
```
If not in a worktree, ask which branch to complete.

**Workspace repo:**
```bash
git branch --show-current
```
Check if the workspace is on a feature branch matching the project branch.

### Step 2: Rebase project repo

```bash
cd repos/{repo}___wt-{branch-slug}
git fetch origin
git rebase origin/{default-branch}
```
If conflicts arise, STOP and present them to the user. Do not auto-resolve.

### Step 3: Capture final discussion state

Run `/braindump` to capture any final discussion/reasoning from this session.
If the user declines or there's nothing to capture, skip.

### Step 4: Gather source material

Formally read ALL three sources before synthesizing — do not write release notes from memory alone:

1. **Branch-scoped specs/plans** in the worktree or `shared-context/{user}/inflight/`:
   - `design-*.md` files
   - `plan-*.md` files
   - Read each one fully

2. **Handoffs touched** — all shared-context entries referencing this branch:
   ```bash
   grep -rl "branch: {branch-name}" shared-context/
   ```
   Read each matching file. Extract key decisions and open questions.

3. **Branch commit log:**
   ```bash
   git log origin/{default-branch}..HEAD --oneline
   ```

### Step 5: Synthesize release notes

Using the gathered material, create two files in the **project repo** (never the workspace repo):

```bash
COMMIT_ID=$(git rev-parse --short HEAD)
mkdir -p release-notes/unreleased
```

**File 1: `release-notes/unreleased/branch-release-notes-{COMMIT_ID}.md`**
```markdown
---
branch: {branch-name}
type: {feature|fix|chore}
author: {user}
date: {YYYY-MM-DD}
---

## {Human-readable title}

{Coherent narrative synthesized from spec + plan + handoffs + commits.
Not a copy-paste — a distilled summary of what was actually implemented.
Include key decisions that differ from the original spec.
Written from scratch per coherent-revisions rule.}
```

**File 2: `release-notes/unreleased/branch-release-questions-{COMMIT_ID}.md`**
```markdown
---
branch: {branch-name}
author: {user}
date: {YYYY-MM-DD}
---

## Open Questions

{Collected from:
- Handoff "Open Questions" sections
- Braindump "Implications" sections
- Spec open questions
- Anything unresolved from the plan
Only genuinely open questions — not things resolved during implementation.}
```

Commit to the project repo:
```bash
git add release-notes/unreleased/
git commit -m "docs: add release notes for {branch-name}"
```

### Step 6: Consume branch-scoped sources

Remove branch-scoped specs and plans from the worktree and inflight/:
```bash
# Worktree sources
rm -f design-*.md plan-*.md
# Inflight sources (only branch-scoped, not project-scoped)
```
Only consume files that are branch-scoped (in inflight/ or the worktree). Leave project-scoped specs in `{user}/` ongoing — those are consumed by /release, not /complete-work.

```bash
git add -u && git commit -m "chore: remove consumed branch-scoped specs and plans"
```

### Step 7: Check for no-remote

Before pushing, verify remotes exist for both repos:
```bash
git remote -v
```
If no remote: "No remote configured for {repo}. Want me to create one on GitHub, or provide a URL?"
Create via `gh repo create` or add the provided URL. Never silently skip push.

### Step 8: Push and create PR — project repo

```bash
git push -u origin {branch-name}
gh pr create --title "{type}: {description}" --body "$(cat <<'EOF'
## Summary
{2-3 bullet points from the release notes}

## Release Notes
See `release-notes/unreleased/branch-release-notes-{COMMIT_ID}.md`

## Test Plan
{Checklist from the plan, or manual testing steps}
EOF
)"
```

### Step 9: Process workspace inflight context

Every file in `shared-context/{user}/inflight/` must be resolved — nothing stays in inflight after /complete-work. For each file, determine its disposition:

**Branch handoffs** (frontmatter references this branch):
- Extract any content not already captured in release notes
- If useful content remains (decisions, patterns worth keeping) → move to `{user}/` ongoing
- If fully consumed by release notes → delete
- Never leave as `lifecycle: resolved` in inflight — that's a dead state

**Session braindumps** (created during this work session):
- If the braindump covers a topic broader than this branch (future ideas, platform vision) → move to `{user}/` ongoing
- If the braindump was specific to this branch's work → content should already be in release notes, delete
- If unsure → ask the user: "Keep {topic} as ongoing context, or discard?"

**Branch-scoped specs/plans** (`design-*`, `plan-*` in inflight/):
- Already removed in Step 6

**Rule: inflight/ should be empty after /complete-work.** If any files remain, something was missed. List them and ask the user what to do.

### Step 10: Push and create PR — workspace repo

```bash
# From workspace root
git add shared-context/
git commit -m "chore: process inflight context for {branch-name}"
git push -u origin {branch-name}
gh pr create --title "context: {branch-name} work session" --body "Workspace context changes from {branch-name} work session."
```

### Step 11: Offer cleanup

Ask: "PRs created. Clean up worktree and local branch? [Y/n]"
If yes:
```bash
cd repos/
git -C {repo} worktree remove {repo}___wt-{branch-slug}
git -C {repo} branch -d {branch-name}
```

Also scan for other stale worktrees:
```bash
git -C repos/{repo} worktree list
```
If stale worktrees found: "Also found `___wt-{old}` with no recent activity. Clean up? [y/N]"

## Handling Unformal Work Sessions

If /complete-work is called but changes were made without a formal work session (no branch, changes on default branch):

Ask: "These changes weren't part of a formal work session. What do you want to do?"
- **Accept as work** — create a branch retroactively, proceed with normal completion
- **Stash for later** — create a user-scoped handoff describing what was done, stash the changes
- **Hand off to someone** — create a team-visible handoff at root shared-context/ for another member to pick up
- **Revert** — undo the changes (with confirmation)

## Notes
- Release notes live in the PROJECT repo, not the workspace repo
- Branch-scoped specs/plans are consumed and removed; project-scoped ones stay in ongoing
- Both repos get PRed — project repo for code, workspace repo for context
- The coherent-revisions rule applies to release notes — synthesize from scratch, don't concatenate sources
