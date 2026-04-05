# Git Conventions

## Branching

- Prefixes: `feature/`, `bugfix/`, `chore/`
- Names: kebab-case after prefix, no grouping/nesting
- Examples: `feature/ble-provisioning`, `bugfix/mqtt-reconnect`
- All branches merge to the repo's default branch
- Branch names should be unique — if revisiting previous work, distinguish the new branch name

## Worktrees

- Feature branches get their own worktree, not a checkout in the main repo
- Worktree naming: `{repo-name}___wt-{branch-slug}`
- Example: `repos/codeapy___wt-ble-provisioning/`
- The main repo clone stays on its default branch
- Remove worktrees when the branch is merged

## Branch Maintenance

- Before creating a PR, fetch and rebase onto the latest parent branch
- If conflicts arise during rebase, stop and present them to the user — do not auto-resolve

## Commits

- Conventional commit format: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- Never amend commits unless explicitly asked
- Never force push unless explicitly asked
