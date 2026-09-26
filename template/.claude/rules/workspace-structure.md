# Workspace Structure

All paths are relative to the workspace root. Two work lifecycles coexist, selected for new work by `workspace.sessionModel` in `workspace.json`: **task** (the forward path — one issue, one branch, one worktree per touched repo, chat at the root) and **session** (supported — a self-contained `work-sessions/{name}/` folder per effort with a workspace worktree and a `session.md` tracker).

## Directory Layout

| Path | Purpose | Tracked? |
|------|---------|----------|
| `repos/{repo}/` | Source clones (always on the default branch) | No |
| `repos/{repo}/.claude/worktrees/{slug}/` | Task worktree for a project repo (`{slug}` = branch with `/` → `-`) | No |
| `.claude/worktrees/{slug}/` | Task worktree for the workspace repo (`--repo .`) — Claude Code's native worktree location; the two converge | No |
| `work-sessions/{name}/workspace/…` | Session lifecycle: workspace worktree, nested project worktrees at `workspace/repos/{repo}/`, `session.md` + artifacts (`design/plan/goal/research/crossref-*.md`) on top | Session branch |
| `workspace-context/` | Team knowledge: `shared/` (ephemerals), `shared/locked/` (canonical truths), `team-member/{user}/` (per-user), `release-notes/` | Yes |
| `workspace-context/index.md`, `canonical.md`, `team-member/{user}/index.md` | Auto-generated catalogs (`canonical.md` = verbatim `shared/locked/`; `.indexignore` excludes paths) — regenerate with `build-workspace-context.mjs`, never hand-edit | Yes |
| `workspace-scratchpad/` | Machine-local, regenerable: session log, hook debug output, chat records `chats/{chat}.json`, chat drawers `chats/{chat}/` (task-lifecycle designs, plans, braindumps, research in progress) | No |
| `CLAUDE.md`, `CLAUDE.local.md`, `.claude/` | Launcher prompt (imports `canonical.md` + `index.md`); per-user prompt; rules, agents, skills, hooks, scripts | All but `CLAUDE.local.md` and `settings.local.json` |

## Workspace-Context Levels

| Level | Path | What lives there | How it gets there |
|-------|------|------------------|-------------------|
| Personal | `team-member/{user}/` | Per-user braindumps, handoffs, research | Default for `/braindump`, `/handoff`, `/aside` |
| Shared | `shared/` | Team-visible ephemerals | Explicit `--scope shared` or `/promote` |
| Canonical | `shared/locked/` | Promoted truths — conventions, discipline, status | `/release` (or `/promote`, locked target) |

Canonical loads verbatim into every session (`CLAUDE.md` → `@workspace-context/canonical.md`); personal only for the active user (`CLAUDE.local.md`). Inflight work state (session tracker, chat drawer) never lives in `workspace-context/` — that is for knowledge that outlives any single effort.

## Dynamic context loading (hooks)

- **`session-start.mjs`** (`SessionStart`): injects the workspace name, a `Chat record:` line naming this chat's record, and a `Workspace root:` line with the launcher's absolute path (git-derived roots land on the source clone from inside a task worktree); with an active session pointer, also the session's name, branch, work item, and shared-context catalog.
- **`subagent-start.mjs`** (`SubagentStart`): gives subagents the canonical truths they miss (subagents do not load `CLAUDE.md`) — locked files under `workspace.subagentInlineMaxBytes` (8192) are inlined with frontmatter stripped, larger ones become pointers, and past `workspace.subagentContextMaxBytes` (32768) the largest demote first. Gitignored and `local-only-*` files are excluded.

Both are Node.js scripts — cross-platform, no shell dependency.

## Spec and Plan Locations — MANDATORY OVERRIDE

**Specs, plans, and goal artifacts MUST be written to the current lifecycle's work area, not to `docs/superpowers/` or any other location.**

- Session: top of the session worktree — `design-{topic}.md`, `plan-{topic}.md`, `goal-{topic}.md`, plus goal-native `research-*.md`/`crossref-*.md` siblings. On the session branch; stripped before the final PR.
- Task: the chat drawer `workspace-scratchpad/chats/{chat}/` — same artifact names. Machine-local; `/complete-work` promotes what deserves to survive into `workspace-context/`.

This overrides external skills' default paths (e.g., Superpowers' `docs/superpowers/specs/`) — those skills defer to user preferences, and this rule IS that override. Never create `docs/superpowers/` directories. Version an existing artifact: `design-{topic}-v2.md`.

## File Naming Conventions

Ephemeral files under `shared/` and `team-member/{user}/` carry a type prefix:

| Skill | Filename prefix |
|-------|-----------------|
| `/braindump` | `braindump_{topic}.md` |
| `/handoff` | `handoff_{topic}.md` |
| `/aside` (full) / `--quick` | `research_{topic}.md` / `braindump_{topic}.md` (`variant: aside`) |
| `/promote` | preserves source prefix |
| `/release` | strips the prefix when locking — `shared/locked/` uses bare names |

Local-only drafts add a `local-only-` prefix to stay gitignored until promoted.

## Rules

- The workspace root stays on its default branch — it is the launcher, not a worktree.
- All real work happens in worktrees — `work-sessions/{name}/workspace/` (session) or a `.claude/worktrees/{slug}/` location (task). Source clones at `repos/{repo}/` never take a feature branch.
- Session content commits to the session branch; task work to task worktrees; drawer writes need no commit (gitignored, machine-local).
- `workspace-scratchpad/` is machine-local and regenerable — losing it costs a re-derivation, not the work. Not all of it is disposable: `session-log.jsonl` is real history no other file carries.
- Hand edits to auto-generated catalogs are overwritten by `build-workspace-context.mjs` — update the source files (or their `description:` frontmatter) instead.

## Per-repo commands

Per-repo test, lint, and build commands belong in `repos/{repo}/CLAUDE.md` under `## Commands`, scoping invocations to that repo instead of the whole monorepo. `/workspace-init` scaffolds the stub.

## Explore before editing

Before editing an unfamiliar codebase, map the affected surface first — typically a `researcher.md` subagent dispatch (`disallowedTools: [Edit, Write, Bash]`) returning affected files, callers, and dependencies. Edit only after the map is established.

## Launching Claude inside a worktree

A git worktree is a context boundary: `CLAUDE.md` discovery stops at the worktree's root, and gitignored content (`repos/`, `local-only-*`, `workspace-scratchpad/`) is absent from it. So a chat launched inside a project worktree — a session's `workspace/repos/{repo}/` or a task's `repos/{repo}/.claude/worktrees/{slug}/` — sees only that repo's own `CLAUDE.md`, not the workspace conventions or hooks. Keep the chat at the workspace root and reach worktrees by path; launch inside one only for deliberately isolated, repo-only work.

## Grep vs LSP

**Grep/Ripgrep** searches content as text — fast, no server, but no language awareness, so symbol searches surface false positives. **LSP** (`mcp__lsp__*`) understands types and scope — find-all-references returns only real usages — but needs an LSP MCP server in `.mcp.json`. Grep when you don't know where to look; LSP for precise navigation of a specific symbol.
