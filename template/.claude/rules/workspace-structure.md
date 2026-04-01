# Workspace Structure

This workspace follows the claude-workspace convention. All paths are relative to the workspace root.

## Directory Layout

| Directory | Purpose | Tracked in git? |
|-----------|---------|-----------------|
| `repos/` | Cloned project repositories and worktrees | No (gitignored) |
| `shared-context/` | Shared memory — handoffs, braindumps, team knowledge | Yes |
| `shared-context/locked/` | Team truths — loaded every session, injected into subagents | Yes |
| `.claude-scratchpad/` | Ephemeral scratch files, analysis, temp exports | No (gitignored) |
| `.claude/` | Claude Code configuration — rules, agents, skills, hooks | Yes (except settings.local.json) |

## Rules

- No files should be created outside `repos/`, `shared-context/`, or `.claude-scratchpad/` unless explicitly asked by the user
- Worktrees live inside `repos/` as siblings to their source repo
- Worktree naming: `{repo-name}___wt-{branch-slug}`
- The main repo clone stays on its default branch — never checkout a feature branch there
- Scratch files, analysis, comparisons, and exports go in `.claude-scratchpad/`
- Specs and plans created during brainstorming go in the active worktree (they are ephemeral — consumed by /complete-work)
