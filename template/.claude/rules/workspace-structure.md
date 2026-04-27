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
| `workspace-context/` | Team knowledge and per-user context | Yes |
| `workspace-context/shared/` | Team-visible content — handoffs, braindumps, research, references | Yes |
| `workspace-context/shared/locked/` | Canonical team truths — auto-concatenated into `canonical.md` and loaded into every session | Yes |
| `workspace-context/team-member/{user}/` | Per-user working context — default destination for personal captures | Yes |
| `workspace-context/index.md` | Auto-generated navigation catalog of `shared/` (locked first, then ephemerals) | Yes |
| `workspace-context/canonical.md` | Auto-generated verbatim concatenation of `shared/locked/*.md` | Yes |
| `workspace-context/team-member/{user}/index.md` | Auto-generated per-user navigation catalog | Yes |
| `workspace-context/.indexignore` | Path prefixes to exclude from `index.md` (e.g., archived release notes) | Yes |
| `workspace-context/release-notes/` | Per-branch release-note artifacts — `unreleased/` and `archive/` | Yes |
| `workspace-scratchpad/` | Disposable workspace-scoped files — session log, hook debug output | No (gitignored, lazy) |
| `CLAUDE.md` | Workspace launcher prompt — imports `canonical.md` and `index.md` | Yes |
| `CLAUDE.local.md` | Per-user prompt — imports `team-member/{user}/index.md` | No (gitignored) |
| `.claude/` | Claude Code configuration — rules, agents, skills, hooks, scripts, lib | Yes (except settings.local.json) |

Session content (tracker, specs, plans) lives at the top of each session's workspace worktree. It is tracked on the session branch, not on main. Pushing the session branch carries durable session thinking across machines. When `/complete-work` finalizes the session, it synthesizes the content into release notes and removes the files from the branch before the final PR so main's top level stays free of session artifacts.

## Workspace-Context Levels

Three layers, in increasing trust order:

| Level | Path | What lives there | How it gets there |
|-------|------|-----------------|--------------------|
| Personal | `team-member/{user}/` | Per-user braindumps, handoffs, research notes | Default destination for `/braindump`, `/handoff`, `/aside` |
| Shared | `shared/` (root) | Team-visible ephemerals — cross-team handoffs, post-release leftovers, references | Explicit choice via `--scope shared` or `/promote` |
| Canonical | `shared/locked/` | Promoted truths — naming conventions, post-release discipline, project status | Promoted by `/release` (or `/promote` with explicit locked target) |

Canonical content is verbatim-loaded into every session via `CLAUDE.md` → `@workspace-context/canonical.md`. Personal content is loaded only for the active user via the gitignored `CLAUDE.local.md`.

Inflight session state lives inside the session worktree at `work-sessions/{name}/workspace/session.md`, not in `workspace-context/`. Workspace-context is for knowledge that outlives any individual session.

## Spec and Plan Locations — MANDATORY OVERRIDE

**Specs and plans MUST be written at the top of the active session's workspace worktree, not to `docs/superpowers/` or any other location.**

- Specs: `design-{topic}.md` at the top of `work-sessions/{session-name}/workspace/`
- Plans: `plan-{topic}.md` at the top of `work-sessions/{session-name}/workspace/`

From inside the worktree, these are plain top-level files (`design-{topic}.md`, `plan-{topic}.md`) sitting alongside `CLAUDE.md` and `workspace.json`. They are tracked on the session branch and travel with the branch on `git push`.

This overrides any default paths specified by external skills (e.g., Superpowers brainstorming defaults to `docs/superpowers/specs/`). Those skills state that user preferences override their defaults — this rule IS that override. Do not create `docs/superpowers/` directories. Do not write specs or plans anywhere other than the top of the active worktree.

If a spec/plan already exists for the current session, version it: `design-{topic}-v2.md`, `design-{topic}-v3.md`.

`/complete-work` reads specs and plans from the worktree to synthesize release notes, then removes them in a dedicated commit before the final PR so main's tree stays pristine.

## File Naming Conventions

- Session folders: `work-sessions/{session-name}/`
- Workspace worktrees: `work-sessions/{session-name}/workspace/`
- Project worktrees: `work-sessions/{session-name}/workspace/repos/{repo-name}/`
- Session trackers: `work-sessions/{session-name}/workspace/session.md`
- Specs: `design-{topic}.md` (top of worktree)
- Plans: `plan-{topic}.md` (top of worktree)

For ephemeral content under `shared/` and `team-member/{user}/`, the filename prefix signals the type:

| Skill | Filename prefix |
|-------|-----------------|
| `/braindump` | `braindump_{topic}.md` |
| `/handoff` | `handoff_{topic}.md` |
| `/aside` (full mode, dispatches researcher) | `research_{topic}.md` |
| `/aside --quick` | `braindump_{topic}.md` (with `variant: aside` in frontmatter) |
| `/promote` | preserves source prefix |
| `/release` | strips prefix when locking — `shared/locked/` files use bare names since location signals the type |

Local-only personal drafts get an additional `local-only-` prefix (e.g., `local-only-braindump_x.md`) which keeps them gitignored until promoted.

## Rules

- The workspace root stays on main — it is the launcher, not the workspace.
- All real work happens in workspace worktrees at `work-sessions/{name}/workspace/`.
- Session content (tracker, specs, plans) is written from inside the worktree and committed on the session branch. Writes from the launcher cannot reach files that live inside a worktree's git-path space.
- Source clones at `repos/{repo-name}/` stay on their default branch — never checkout a feature branch there.
- `workspace-scratchpad/` is for disposable files only — session log, hook debug output, temporary pointers.
- Project worktrees are nested inside the workspace worktree's real `repos/` directory — no symlink.
- Hand edits to `index.md`, `canonical.md`, or any per-user `team-member/{user}/index.md` are overwritten by `build-workspace-context.mjs`. Update source files (or their `description:` frontmatter) instead.
