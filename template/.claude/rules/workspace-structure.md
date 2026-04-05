# Workspace Structure

This workspace follows the claude-workspace convention. All paths are relative to the workspace root.

## Directory Layout

| Directory | Purpose | Tracked in git? |
|-----------|---------|-----------------|
| `repos/` | Cloned project repositories and worktrees | No (gitignored) |
| `shared-context/` | Shared memory — handoffs, braindumps, team knowledge | Yes |
| `shared-context/locked/` | Team truths — loaded every session, injected into subagents | Yes |
| `shared-context/{user}/` | User-scoped working context — default for all captures | Yes |
| `shared-context/{user}/inflight/` | Current work-session artifacts — consumed by /complete-work | Yes |
| `.claude-scratchpad/` | Truly disposable files — temp diffs, debug output, tool artifacts | No (gitignored) |
| `.claude/` | Claude Code configuration — rules, agents, skills, hooks | Yes (except settings.local.json) |

## Shared Context Levels

| Level | What lives there | Default? |
|-------|-----------------|----------|
| `locked/` | Team truths — always loaded, injected into subagents | Promoted by /release |
| Root | Team-visible ephemerals — cross-team handoffs, post-release leftovers | Explicit choice |
| `{user}/` | Ongoing personal context — persists across work sessions | Default for captures |
| `{user}/inflight/` | Current work-session artifacts — specs, plans, session braindumps | Created by /start-work |

User-scoped is the default. Root is only for content deliberately made team-visible.

## Naming Conventions

- Specs: `design-{topic}.md`
- Plans: `plan-{topic}.md`
- Handoffs and braindumps: named by topic (no date prefix — use frontmatter `updated:`)
- Worktrees: `{repo-name}___wt-{branch-slug}`

## Rules

- No files should be created outside `repos/`, `shared-context/`, or `.claude-scratchpad/` unless explicitly asked
- Worktrees live inside `repos/` as siblings to their source repo
- The main repo clone stays on its default branch — never checkout a feature branch there
- Never make changes to a repo's default branch directly — all changes go through worktrees
- `.claude-scratchpad/` is for truly disposable files only — anything worth keeping goes in `shared-context/`
