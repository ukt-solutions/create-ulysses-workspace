# Workspace Structure

This workspace follows the claude-workspace convention. All paths are relative to the workspace root.

## Directory Layout

| Directory | Purpose | Tracked in git? |
|-----------|---------|-----------------|
| `repos/` | Source clones of project repositories (one per repo, stays on default branch) | No (gitignored, lazy) |
| `work-sessions/` | Per-session folders — one folder per active or paused work session | No (gitignored entirely at the launcher) |
| `work-sessions/{name}/workspace/` | Workspace worktree for this session, on the session branch | Yes — on the session branch, not on main |
| `work-sessions/{name}/workspace/session.md` | Unified session tracker at the top of the session branch (frontmatter = machine state, body = human content) | Yes — on the session branch |
| `work-sessions/{name}/workspace/design-*.md` | Specs for this session — consumed into release notes by /complete-work | Yes — on the session branch |
| `work-sessions/{name}/workspace/plan-*.md` | Plans for this session — consumed into release notes by /complete-work | Yes — on the session branch |
| `work-sessions/{name}/workspace/repos/` | Real directory holding nested project worktrees for this session | No (gitignored) |
| `work-sessions/{name}/workspace/repos/{repo}/` | Project worktree nested inside the workspace worktree | No (gitignored) |
| `shared-context/` | Shared memory — handoffs, braindumps, team knowledge | Yes |
| `shared-context/locked/` | Team truths — loaded every session, injected into subagents | Yes |
| `shared-context/{user}/` | User-scoped working context — default for all captures | Yes |
| `workspace-scratchpad/` | Disposable workspace-scoped files — session log, hook debug output | No (gitignored, lazy) |
| `.claude/` | Claude Code configuration — rules, agents, skills, hooks, scripts, lib | Yes (except settings.local.json) |

Session content (tracker, specs, plans) lives at the top of each session's workspace worktree. It is tracked on the session branch, not on main. Pushing the session branch carries durable session thinking across machines. When `/complete-work` finalizes the session, it synthesizes the content into release notes and removes the files from the branch before the final PR so main's top level stays free of session artifacts.

## Shared Context Levels

| Level | What lives there | Default? |
|-------|-----------------|----------|
| `locked/` | Team truths — always loaded, injected into subagents | Promoted by /release |
| Root | Team-visible ephemerals — cross-team handoffs, post-release leftovers | Explicit choice |
| `{user}/` | Ongoing personal context — persists across work sessions | Default for captures |

Inflight session state lives inside the session worktree at `work-sessions/{name}/workspace/session.md`, not in `shared-context/`. Shared-context is for knowledge that outlives any individual session.

User-scoped is the default for captures. Root is only for content deliberately made team-visible.

## Spec and Plan Locations — MANDATORY OVERRIDE

**Specs and plans MUST be written at the top of the active session's workspace worktree, not to `docs/superpowers/` or any other location.**

- Specs: `design-{topic}.md` at the top of `work-sessions/{session-name}/workspace/`
- Plans: `plan-{topic}.md` at the top of `work-sessions/{session-name}/workspace/`

From inside the worktree, these are plain top-level files (`design-{topic}.md`, `plan-{topic}.md`) sitting alongside `CLAUDE.md` and `workspace.json`. They are tracked on the session branch and travel with the branch on `git push`.

This overrides any default paths specified by external skills (e.g., Superpowers brainstorming defaults to `docs/superpowers/specs/`). Those skills state that user preferences override their defaults — this rule IS that override. Do not create `docs/superpowers/` directories. Do not write specs or plans anywhere other than the top of the active worktree.

If a spec/plan already exists for the current session, version it: `design-{topic}-v2.md`, `design-{topic}-v3.md`.

`/complete-work` reads specs and plans from the worktree to synthesize release notes, then removes them in a dedicated commit before the final PR so main's tree stays pristine.

## Naming Conventions

- Session folders: `work-sessions/{session-name}/`
- Workspace worktrees: `work-sessions/{session-name}/workspace/`
- Project worktrees: `work-sessions/{session-name}/workspace/repos/{repo-name}/`
- Session trackers: `work-sessions/{session-name}/workspace/session.md`
- Specs: `design-{topic}.md` (top of worktree)
- Plans: `plan-{topic}.md` (top of worktree)
- Handoffs and braindumps: named by topic (no date prefix — use frontmatter `updated:`)

## Rules

- The workspace root stays on main — it is the launcher, not the workspace.
- All real work happens in workspace worktrees at `work-sessions/{name}/workspace/`.
- Session content (tracker, specs, plans) is written from inside the worktree and committed on the session branch. Writes from the launcher cannot reach files that live inside a worktree's git-path space.
- Source clones at `repos/{repo-name}/` stay on their default branch — never checkout a feature branch there.
- `workspace-scratchpad/` is for disposable files only — session log, hook debug output, temporary pointers.
- Project worktrees are nested inside the workspace worktree's real `repos/` directory — no symlink.
