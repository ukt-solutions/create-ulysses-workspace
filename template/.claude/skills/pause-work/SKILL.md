---
name: pause-work
description: Suspend current work — captures state, pushes both repos, creates a draft PR. Use when stepping away from work that isn't finished.
---

# Pause Work

Suspend the current branch — save context, push both repos, create a draft PR.

## Flow

**Step 1: Detect context**
Determine the current worktree, branch, and repo:
```bash
git -C repos/{repo}___wt-{branch-slug} branch --show-current
```
Check workspace repo branch:
```bash
git branch --show-current
```
If not on a feature branch in either repo, ask which work session to pause.

**Step 2: Capture discussion state**
Run `/braindump` to capture any discussion/reasoning from this session.
If the user declines or there's nothing to capture, skip.

**Step 3: Capture workstream state**
Run `/handoff` to capture the current work state.
If the user declines, skip.
If a handoff is created/updated, set its `lifecycle` to `paused`.

**Step 4: Check for no-remote**
Before pushing, verify remotes exist for both repos:
```bash
git -C repos/{repo} remote -v
git remote -v
```
If no remote on either: "No remote configured for {repo}. Want me to create one on GitHub, or provide a URL?"
Create via `gh repo create` or add the provided URL. Never silently skip push.

**Step 5: Push and create draft PR — project repo**
```bash
cd repos/{repo}___wt-{branch-slug}
git push -u origin {branch-name}
gh pr create --draft --title "[DRAFT] {branch-description}" --body "Work in progress. See shared-context for handoff details."
```
If a PR already exists, update it to draft status if needed.

**Step 6: Push workspace repo**
```bash
# From workspace root
git add shared-context/
git commit -m "handoff: pause {branch-name}"
git push -u origin {branch-name}
```

**Step 7: Report**
"Work paused. Draft PR: {url}. Context saved to shared-context/{user}/{handoff-name}.md."

## Notes
- This does NOT clean up the worktree — the user may resume later
- The work session marker (`.claude-scratchpad/.work-session-{branch-slug}`) is kept — the session is paused, not ended
- Related shared-context entries get `lifecycle: paused`
- Both repos get pushed (project repo + workspace repo)
- To resume: `/start-work handoff`
