# Git Conventions

## Branching

- Prefixes: `feature/`, `bugfix/`, `chore/`
- Names: kebab-case after prefix, no grouping/nesting
- Examples: `feature/ble-provisioning`, `bugfix/mqtt-reconnect`
- All branches merge to the repo's default branch
- Branch names should be unique — if revisiting previous work, distinguish the new branch name

## Worktrees

Work happens in worktrees, never in the source clones. A task is one issue, one branch and one worktree per repo it touches, created and removed with `.claude/scripts/task-worktree.mjs`; the chat stays at the workspace root.

- Project repos: `repos/{repo}/.claude/worktrees/{slug}/`, where `{slug}` is the branch with `/` replaced by `-`
- The workspace repo itself, addressed as `.`: `.claude/worktrees/{slug}/` — Claude Code's native worktree location
- Source clones at `repos/{repo}/` stay on their default branch; `/complete-work` tears each worktree down with `task-worktree.mjs --remove` (worktree first, then the branch)

The workspace `.gitignore` covers it: `.claude/worktrees/` for the workspace repo's own worktrees, and `repos` (no trailing slash) for every `repos/` directory at any depth. A workspace that still has `work-sessions/` folders from the session lifecycle of earlier template versions drains them with `/migrate-sessions`.

## Branch Maintenance

- Before creating a PR, fetch and rebase onto the latest parent branch
- If conflicts arise during rebase, stop and present them to the user — do not auto-resolve

## Commits

- Conventional commit format: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- Never amend commits unless explicitly asked
- Never force push unless explicitly asked
