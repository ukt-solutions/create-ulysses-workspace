# Git Conventions

## Branching

- Prefixes: `feature/`, `bugfix/`, `chore/`
- Names: kebab-case after prefix, no grouping/nesting
- Examples: `feature/ble-provisioning`, `bugfix/mqtt-reconnect`
- All branches merge to the repo's default branch
- Branch names should be unique — if revisiting previous work, distinguish the new branch name

## Worktrees

- Work sessions get N+1 worktrees: one for the workspace, plus one per project repo
- Worktree naming: `{session-name}___wt-{type}` where type is `workspace` or `{repo-name}`
- Examples: `repos/migrate-tool___wt-workspace/`, `repos/migrate-tool___wt-my-app/`
- All worktrees for a session are adjacent in directory listings
- The main repo clone and workspace root stay on their default branches
- Remove worktrees when the work session is completed

## Branch Maintenance

- Before creating a PR, fetch and rebase onto the latest parent branch
- If conflicts arise during rebase, stop and present them to the user — do not auto-resolve

## Commits

- Conventional commit format: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- Never amend commits unless explicitly asked
- Never force push unless explicitly asked
