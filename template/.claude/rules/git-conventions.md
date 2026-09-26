# Git Conventions

## Branching

- Prefixes: `feature/`, `bugfix/`, `chore/`
- Names: kebab-case after prefix, no grouping/nesting
- Examples: `feature/ble-provisioning`, `bugfix/mqtt-reconnect`
- All branches merge to the repo's default branch
- Branch names should be unique — if revisiting previous work, distinguish the new branch name

## Worktrees

Both lifecycles are built on worktrees; `workspace.sessionModel` in `workspace.json` routes new work to one of them.

**Task model** (`"task"`): one worktree per repo the task touches, created and removed with `.claude/scripts/task-worktree.mjs` (the chat stays at the workspace root):

- Project repos: `repos/{repo}/.claude/worktrees/{slug}/`, where `{slug}` is the branch with `/` replaced by `-`
- The workspace repo itself, addressed as `.`: `.claude/worktrees/{slug}/` — Claude Code's native worktree location
- Source clones at `repos/{repo}/` stay on their default branch; `/complete-work` tears each worktree down with `task-worktree.mjs --remove` (worktree first, then the branch)

**Session model** (default): N+1 worktrees in one self-contained folder at `work-sessions/{session-name}/`:

- `work-sessions/{session-name}/workspace/` — workspace worktree
- `work-sessions/{session-name}/workspace/repos/{repo-name}/` — project worktrees nested inside it (no symlink)
- Example, session `fix-auth` on `bugfix/fix-auth` touching `my-app` and `my-api`: `work-sessions/fix-auth/workspace/` plus `workspace/repos/my-app/` and `workspace/repos/my-api/`
- Teardown order is mandatory: project worktrees first, then the workspace worktree, then prune — the cleanup helper enforces it

The workspace `.gitignore` covers all of it: `repos` (no trailing slash) matches the root's `repos/` and every session worktree's nested `repos/`; `.claude/worktrees/` matches task worktrees of the workspace repo itself.

## Branch Maintenance

- Before creating a PR, fetch and rebase onto the latest parent branch
- If conflicts arise during rebase, stop and present them to the user — do not auto-resolve

## Commits

- Conventional commit format: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- Never amend commits unless explicitly asked
- Never force push unless explicitly asked
