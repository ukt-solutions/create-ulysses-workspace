# Workspace Structure

All paths are relative to the workspace root. Work has one lifecycle: **task** — one issue, one branch, one worktree per touched repo, with the chat at the root. A workspace that still has `work-sessions/` folders from the session lifecycle of earlier template versions drains them with `/migrate-sessions`.

## Directory Layout

| Path | Purpose | Tracked? |
|------|---------|----------|
| `repos/{repo}/` | Source clones (always on the default branch) | No |
| `repos/{repo}/.claude/worktrees/{slug}/` | Task worktree for a project repo (`{slug}` = branch with `/` → `-`) | No |
| `.claude/worktrees/{slug}/` | Task worktree for the workspace repo (`--repo .`) — Claude Code's native worktree location; the two converge | No |
| `workspace-context/` | Team knowledge: `shared/` (ephemerals), `shared/locked/` (canonical truths), `team-member/{user}/` (per-user) | Yes |
| `workspace-context/index.md`, `canonical.md` | Auto-generated catalogs (`canonical.md` = verbatim `shared/locked/`; `.indexignore` excludes paths) — regenerate with `build-workspace-context.mjs`, never hand-edit | Yes |
| `workspace-context/team-member/{user}/index.md` | The per-user slice of that catalog — gitignored: generated per machine, so a tracked copy would conflict across users; the personal files beside it stay tracked | No |
| `workspace-scratchpad/` | Machine-local, regenerable: session log, hook debug output, chat records `chats/{chat}.json`, chat drawers `chats/{chat}/` (designs, plans, braindumps, research in progress) | No |
| `CLAUDE.md`, `CLAUDE.local.md`, `.claude/` | Launcher prompt (imports `canonical.md` + `index.md`); per-user prompt; rules, agents, skills, hooks, scripts | All but `CLAUDE.local.md`, `settings.local.json`, and `.claude/worktrees/` |

## Workspace-Context Levels

| Level | Path | What lives there | How it gets there |
|-------|------|------------------|-------------------|
| Personal | `team-member/{user}/` | Per-user braindumps, handoffs, research | Where `/aside` always writes, and `/braindump` and `/handoff` write when the chat has no drawer (no `Chat record:` line); a chat with a drawer sends those two to the drawer instead |
| Shared | `shared/` | Team-visible ephemerals | Explicit `--scope shared` or `/promote` |
| Canonical | `shared/locked/` | Promoted truths — conventions, discipline, status | `/promote` (locked target) |

Canonical loads verbatim into every session (`CLAUDE.md` → `@workspace-context/canonical.md`); personal only for the active user (`CLAUDE.local.md`). Inflight work state — the chat drawer — never lives in `workspace-context/`: that is for knowledge that outlives any single effort.

## Dynamic context loading (hooks)

- **`session-start.mjs`** (`SessionStart`): injects the workspace name, a `Workspace config (workspace.json):` line, a `Chat record:` line for this chat, and a `Workspace root:` line with the launcher's path (git-derived roots land on the source clone in a task worktree). At the launcher it adds one line when legacy sessions remain — how many sit under the old session model, and that `/migrate-sessions` can drain them — counted from the sessions directory's non-dot entries alone.
- **`subagent-start.mjs`** (`SubagentStart`): gives subagents the canonical truths they miss (subagents do not load `CLAUDE.md`) — locked files under `workspace.subagentInlineMaxBytes` (8192) are inlined with frontmatter stripped, larger ones become pointers, and past `workspace.subagentContextMaxBytes` (32768) the largest demote first. Gitignored and `local-only-*` files are excluded.

Both are Node.js scripts — cross-platform, no shell dependency.

## Spec and Plan Locations — MANDATORY OVERRIDE

**Specs, plans, and goal artifacts MUST be written to the chat drawer `workspace-scratchpad/chats/{chat}/`, not to `docs/superpowers/` or any other location.** They are `design-{topic}.md`, `plan-{topic}.md`, `goal-{topic}.md`, plus goal-native `research-*.md`/`crossref-*.md` siblings: machine-local, and `/complete-work` promotes what deserves to survive into `workspace-context/`.

This overrides external skills' default paths (e.g., Superpowers' `docs/superpowers/specs/`) — those skills defer to user preferences, and this rule IS that override. Never create `docs/superpowers/` directories. Version an existing artifact: `design-{topic}-v2.md`.

## File Naming Conventions

Ephemeral files under `shared/` and `team-member/{user}/` carry a type prefix:

| Skill | Filename prefix |
|-------|-----------------|
| `/braindump` | `braindump_{topic}.md` |
| `/handoff` | `handoff_{topic}.md` |
| `/aside` (full) / `--quick` | `research_{topic}.md` / `braindump_{topic}.md` (`variant: aside`) |
| `/promote` | preserves source prefix |

Local-only drafts add a `local-only-` prefix to stay gitignored until promoted.

## Rules

- The workspace root stays on its default branch — it is the launcher, not a worktree.
- All real work happens in worktrees — a task's at `repos/{repo}/.claude/worktrees/{slug}/`, or `.claude/worktrees/{slug}/` for the workspace repo itself. Source clones at `repos/{repo}/` never take a feature branch.
- Task work commits in its task worktrees; drawer writes need no commit (gitignored, machine-local).
- `workspace-scratchpad/` is machine-local and regenerable — losing it costs a re-derivation, not the work. Not all of it is disposable: `session-log.jsonl` is real history no other file carries.
- Hand edits to auto-generated catalogs are overwritten by `build-workspace-context.mjs` — update the source files (or their `description:` frontmatter) instead.

## Per-repo commands

Per-repo test, lint, and build commands belong in `repos/{repo}/CLAUDE.md` under `## Commands`, scoping invocations to that repo instead of the whole monorepo. `/workspace-init` scaffolds the stub.

## Explore before editing

Before editing an unfamiliar codebase, map the affected surface first — typically a `researcher.md` subagent dispatch (`disallowedTools: [Edit, Write, Bash]`) returning affected files, callers, and dependencies. Edit only after the map is established.

## Launching Claude inside a worktree

A git worktree is a context boundary: `CLAUDE.md` discovery stops at the worktree's root, and gitignored content (`repos/`, `local-only-*`, `workspace-scratchpad/`) is absent from it. So a chat launched inside a project worktree — a task's `repos/{repo}/.claude/worktrees/{slug}/` — sees only that repo's own `CLAUDE.md`, not the workspace conventions or hooks. Keep the chat at the workspace root and reach worktrees by path; launch inside one only for deliberately isolated, repo-only work.

## Grep vs LSP

**Grep/Ripgrep** searches content as text — fast, no server, but no language awareness, so symbol searches surface false positives. **LSP** (`mcp__lsp__*`) understands types and scope — find-all-references returns only real usages — but needs an LSP MCP server in `.mcp.json`. Grep when you don't know where to look; LSP for precise navigation of a specific symbol.
