---
name: pause-work
description: Suspend current work — captures state, pushes code, creates a draft PR. Use when stepping away from work that isn't finished.
---

# Pause Work

Suspend the current branch — save context, push code, create a draft PR.

## Flow

**Step 1: Detect context**
Determine the current worktree and branch:
```bash
git branch --show-current
pwd
```
If not in a worktree, ask which branch to pause.

**Step 2: Capture discussion state**
Run `/braindump` to capture any discussion/reasoning from this session.
- If the user declines or there's nothing to capture, skip.

**Step 3: Capture workstream state**
Run `/handoff` to capture the current work state.
- If the user declines, skip.
- If a handoff is created/updated, set its `lifecycle` to `paused`.

**Step 4: Push and create draft PR**
```bash
git push -u origin {branch-name}
```
Create a draft PR with `[DRAFT]` title prefix:
```bash
gh pr create --draft --title "[DRAFT] {branch-description}" --body "Work in progress. See shared-context for handoff details."
```
If a PR already exists, update it to draft status if needed.

**Step 5: Report**
"Work paused. Draft PR: {url}. Context saved to shared-context/{handoff-name}.md."

## Notes
- This does NOT clean up the worktree — the user may resume later
- Related shared-context entries get `lifecycle: paused`
- To resume: `/start-work handoff`
