# Workspace Structure

This workspace follows the claude-workspace convention. All paths are relative to the workspace root.

## Directory Layout

| Directory | Purpose | Tracked in git? |
|-----------|---------|-----------------|
| `repos/` | Cloned project repositories and worktrees | No (gitignored) |
| `repos/{session}___wt-workspace/` | Workspace worktree for a work session | No (gitignored) |
| `repos/{session}___wt-{repo}/` | Project repo worktree for a work session | No (gitignored) |
| `shared-context/` | Shared memory — handoffs, braindumps, team knowledge | Yes |
| `shared-context/locked/` | Team truths — loaded every session, injected into subagents | Yes |
| `shared-context/{user}/` | User-scoped working context — default for all captures | Yes |
| `shared-context/{user}/inflight/` | Current work-session artifacts — consumed by /complete-work | Yes |
| `.claude-scratchpad/` | Disposable files — session markers, temp diffs, debug output | No (gitignored) |
| `.claude/` | Claude Code configuration — rules, agents, skills, hooks, scripts | Yes (except settings.local.json) |

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
- Worktrees: `{session-name}___wt-workspace` or `{session-name}___wt-{repo-name}`
- Session markers: `.work-session-{session-name}.json`
- Inflight trackers: `session-{session-name}.md`

## Rules

- The workspace root stays on main — it is the launcher, not the workspace
- All real work happens in workspace worktrees (`repos/{session}___wt-workspace/`)
- From the workspace root, only `local-only-*` files and `.claude-scratchpad/` are writable
- Worktrees live inside `repos/` as siblings to their source repo
- The main repo clone stays on its default branch — never checkout a feature branch there
- `.claude-scratchpad/` is for disposable files only — session markers, temp output, pointers
