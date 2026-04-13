# Workspace Structure

This workspace follows the claude-workspace convention. All paths are relative to the workspace root.

## Directory Layout

| Directory | Purpose | Tracked in git? |
|-----------|---------|-----------------|
| `repos/` | Source clones of project repositories (one per repo, stays on default branch) | No (gitignored, lazy) |
| `work-sessions/` | Per-session folders — one folder per active or paused work session | Mostly gitignored (see exceptions below) |
| `work-sessions/{name}/workspace/` | Workspace worktree for this session | No (gitignored) |
| `work-sessions/{name}/workspace/repos/` | Real directory holding nested project worktrees for this session | No (gitignored) |
| `work-sessions/{name}/workspace/repos/{repo}/` | Project worktree nested inside the workspace worktree | No (gitignored) |
| `work-sessions/{name}/session.md` | Unified session tracker — frontmatter = machine state, body = human content | **Yes** (exception) |
| `work-sessions/{name}/design-*.md` | Specs for this session — consumed into release notes by /complete-work | **Yes** (exception) |
| `work-sessions/{name}/plan-*.md` | Plans for this session — consumed into release notes by /complete-work | **Yes** (exception) |
| `shared-context/` | Shared memory — handoffs, braindumps, team knowledge | Yes |
| `shared-context/locked/` | Team truths — loaded every session, injected into subagents | Yes |
| `shared-context/{user}/` | User-scoped working context — default for all captures | Yes |
| `workspace-scratchpad/` | Disposable workspace-scoped files — session log, hook debug output | No (gitignored, lazy) |
| `.claude/` | Claude Code configuration — rules, agents, skills, hooks, scripts, lib | Yes (except settings.local.json) |

The `work-sessions/` folder uses a gitignored-folder-with-tracked-file-exception pattern: the folder is gitignored, but specific filename patterns inside each session folder (the session tracker, specs, plans) are explicitly un-ignored. This lets durable session thinking travel across machines via the workspace branch while keeping worktrees and other local artifacts per-machine.

## Shared Context Levels

| Level | What lives there | Default? |
|-------|-----------------|----------|
| `locked/` | Team truths — always loaded, injected into subagents | Promoted by /release |
| Root | Team-visible ephemerals — cross-team handoffs, post-release leftovers | Explicit choice |
| `{user}/` | Ongoing personal context — persists across work sessions | Default for captures |

Inflight session state lives in the session folder (`work-sessions/{name}/session.md`), not in `shared-context/`. Shared-context is for knowledge that outlives any individual session.

User-scoped is the default for captures. Root is only for content deliberately made team-visible.

## Spec and Plan Locations — MANDATORY OVERRIDE

**Specs and plans MUST be written to the active session folder, not to `docs/superpowers/` or any other location.**

- Specs: `design-{topic}.md` in `work-sessions/{session-name}/`
- Plans: `plan-{topic}.md` in `work-sessions/{session-name}/`

This overrides any default paths specified by external skills (e.g., Superpowers brainstorming defaults to `docs/superpowers/specs/`). Those skills state that user preferences override their defaults — this rule IS that override. Do not create `docs/superpowers/` directories. Do not write specs or plans anywhere other than the session folder.

If a spec/plan already exists for the current session, version it: `design-{topic}-v2.md`, `design-{topic}-v3.md`.

Specs and plans are session artifacts — they are consumed by `/complete-work` into release notes, then removed along with the rest of the session folder.

## Naming Conventions

- Session folders: `work-sessions/{session-name}/`
- Workspace worktrees: `work-sessions/{session-name}/workspace/`
- Project worktrees: `work-sessions/{session-name}/workspace/repos/{repo-name}/`
- Session trackers: `work-sessions/{session-name}/session.md`
- Specs: `design-{topic}.md` (inside session folder)
- Plans: `plan-{topic}.md` (inside session folder)
- Handoffs and braindumps: named by topic (no date prefix — use frontmatter `updated:`)

## Rules

- The workspace root stays on main — it is the launcher, not the workspace
- All real work happens in workspace worktrees at `work-sessions/{name}/workspace/`
- From the workspace root, only `local-only-*` files and `workspace-scratchpad/` are writable
- Source clones at `repos/{repo-name}/` stay on their default branch — never checkout a feature branch there
- `workspace-scratchpad/` is for disposable files only — session log, hook debug output, temporary pointers
- Project worktrees are nested inside the workspace worktree's real `repos/` directory — no symlink
