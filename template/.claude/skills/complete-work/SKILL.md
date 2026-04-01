---
name: complete-work
description: Finalize a branch — rebase, synthesize release notes from specs/plans/handoffs/commits, create PR. Use when work on a branch is done.
---

# Complete Work

Finalize the current branch — distill everything into release notes and create a PR.

## Flow

**Step 1: Detect context**
Determine the current worktree, branch, and repo:
```bash
git branch --show-current
pwd
```
If not in a worktree, ask which branch to complete.

**Step 2: Rebase onto parent branch**
```bash
git fetch origin
git rebase origin/{default-branch}
```
If conflicts arise, STOP and present them to the user. Do not auto-resolve.

**Step 3: Capture final discussion state**
Run `/braindump` to capture any final discussion/reasoning.
If the user declines, skip.

**Step 4: Gather source material**
Read the following if they exist:
- Spec file in the worktree (e.g., `docs/superpowers/specs/*-design.md`)
- Plan file in the worktree (e.g., `docs/superpowers/plans/*-plan.md`)
- All shared-context entries that reference this branch (match `branch:` frontmatter)
- Branch commit log: `git log origin/{default-branch}..HEAD --oneline`

**Step 5: Synthesize release notes**
Using the gathered material, create two files in the **project repo** (not the workspace repo):

Get a suitable short commit ID:
```bash
COMMIT_ID=$(git rev-parse --short HEAD)
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

{Coherent narrative of what was built and why, synthesized from spec + plan + commits.
Not a copy-paste of the spec — a distilled summary of what was actually implemented.
Include key decisions made during implementation that differ from the original spec.}
```

**File 2: `release-notes/unreleased/branch-release-questions-{COMMIT_ID}.md`**
```markdown
---
branch: {branch-name}
author: {user}
date: {YYYY-MM-DD}
---

## Open Questions

{Collected from handoff "Open Questions" sections and any unresolved items
from the braindump "Implications" sections. Only include genuinely open questions —
not things that were resolved during implementation.}
```

Create the directory if it doesn't exist:
```bash
mkdir -p release-notes/unreleased
```

Commit these files to the project repo:
```bash
git add release-notes/unreleased/branch-release-notes-*.md release-notes/unreleased/branch-release-questions-*.md
git commit -m "docs: add release notes for {branch-name}"
```

**Step 6: Clean up consumed sources**
Remove spec and plan files from the worktree (they've been consumed):
```bash
rm -f docs/superpowers/specs/*-design.md docs/superpowers/plans/*-plan.md
git add -u && git commit -m "chore: remove consumed spec/plan files"
```

**Step 7: Push and create PR**
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

**Step 8: Update shared context**
Mark all shared-context entries referencing this branch as `lifecycle: resolved`.

**Step 9: Offer cleanup**
Ask: "PR created. Clean up worktree and local branch? [Y/n]"
If yes:
```bash
cd repos/
git -C {repo} worktree remove {repo}___wt-{branch-slug}
git -C {repo} branch -d {branch-name}
```

## Notes
- Specs/plans are ephemeral — consumed into release notes, then removed
- Release notes live in the PROJECT repo, not the workspace repo
- The release notes are the permanent artifact; everything else is working material
