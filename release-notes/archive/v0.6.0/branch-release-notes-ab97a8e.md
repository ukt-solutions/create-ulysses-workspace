---
branch: bugfix/gitignore-symlink
type: fix
author: myron
date: 2026-04-12
---

## CRITICAL: .gitignore symlink destruction bug

Fixed a destructive bug in the template's `.gitignore` that could silently destroy a user's entire `repos/` directory and everything inside it — project clones, worktrees, active work sessions.

### What was happening

The start-work helper creates a symlink named `repos` inside every workspace worktree (so the worktree can see its sibling project worktrees). The template's `.gitignore` had `repos/` with a trailing slash. Git's gitignore patterns treat trailing-slash patterns as matching real directories only, not symlinks. So the symlink was NOT being ignored.

Running `git add -A` inside a workspace worktree — which skills do routinely — staged the symlink. The commit got merged to main. When the user then ran `git pull` at the workspace root, git saw a tracked file named `repos` and tried to materialize it. The real `repos/` directory was already there but had no tracked contents (everything inside was gitignored), so git treated it as empty and replaced it with the symlink. The filesystem can only hold one entry at a path — the directory and everything inside it was destroyed.

### The fix

Three layers of protection:

1. **Template `.gitignore` updated.** `repos/` and `.claude-scratchpad/` lose their trailing slashes. Without the slash, the pattern matches both directories and symlinks. A detailed comment explains the reasoning.

2. **`workspace-update` skill adds a migration step.** When run on an existing workspace, it checks for the vulnerable pattern and offers to fix it — including untracking any `repos` symlink that was already committed. Runs before any other update to prevent the update itself from triggering the bug.

3. **`create-work-session.mjs` refuses to run with the vulnerable pattern.** Belt and suspenders — even if a user skips `workspace-update`, the session creator will abort before creating the symlink, forcing the gitignore fix first.

### Action required for existing workspaces

Run `npx create-ulysses-workspace --upgrade` (or local equivalent) and then `/workspace-update`. The migration step will handle the fix automatically. Alternatively, manually change `repos/` to `repos` in your workspace's `.gitignore` and untrack any committed `repos` symlink with `git rm --cached repos`.

### How this happened

The bug was introduced when the start-work helper was built. The symlink was an intentional design choice — it lets workspace worktrees see their sibling project worktrees without absolute paths. But the gitignore pattern wasn't tightened to match, and nothing in the template exercised `git add -A` on a worktree with the symlink inside until recently. The recent fix to consume the inflight tracker at the end of `/complete-work` is what made this reachable.
