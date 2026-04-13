# Git Conventions

## Branching

- Prefixes: `feature/`, `bugfix/`, `chore/`
- Names: kebab-case after prefix, no grouping/nesting
- Examples: `feature/ble-provisioning`, `bugfix/mqtt-reconnect`
- All branches merge to the repo's default branch
- Branch names should be unique — if revisiting previous work, distinguish the new branch name

## Worktrees

- Work sessions get N+1 worktrees: one for the workspace, plus one per project repo
- Each session lives in a self-contained folder at `work-sessions/{session-name}/`
- The workspace worktree is at `work-sessions/{session-name}/workspace/`
- Project worktrees are nested inside the workspace worktree at `work-sessions/{session-name}/workspace/repos/{repo-name}/`
- Example: for a session `fix-auth` on branch `bugfix/fix-auth` touching repos `my-app` and `my-api`:
  - `work-sessions/fix-auth/workspace/` — workspace worktree
  - `work-sessions/fix-auth/workspace/repos/my-app/` — project worktree
  - `work-sessions/fix-auth/workspace/repos/my-api/` — project worktree
- The workspace repo's `.gitignore` pattern `repos` (no trailing slash) covers both the workspace root's `repos/` and the nested `repos/` inside every worktree
- Source clones at `repos/{repo-name}/` (at the workspace root) stay on their default branch at all times
- Remove worktrees when the work session is completed — use the cleanup helper to enforce the mandatory teardown order (project worktrees first, then workspace worktree, then prune)

## Branch Maintenance

- Before creating a PR, fetch and rebase onto the latest parent branch
- If conflicts arise during rebase, stop and present them to the user — do not auto-resolve

## Commits

- Conventional commit format: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- Never amend commits unless explicitly asked
- Never force push unless explicitly asked
