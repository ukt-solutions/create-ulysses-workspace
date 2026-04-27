# Memory Guidance

Guide Claude's auto-memory system for this workspace.

## What to Auto-Remember

When working in this workspace, pay attention to and save memories about:
- Architecture decisions and their rationale
- Patterns that caused bugs or confusion
- User corrections about project conventions
- External system URLs, credentials locations, API quirks
- Workarounds for tooling issues

## What NOT to Auto-Remember

- Temporary debugging state
- File contents (re-read them instead)
- Anything already captured in a workspace-context file
- Anything documented in .claude/rules/

## Session-Scoped vs Cross-Session

When a work session is active:
- Decisions and progress from this session → update the session tracker body at `work-sessions/{name}/workspace/session.md` (consumed by /complete-work)
- Patterns, corrections, and insights that apply beyond this session → auto-memory (persists across all sessions)
- Don't duplicate: if something is already in the session tracker, don't also save it to auto-memory

## Workspace-Context Frontmatter

Every workspace-context file should have YAML frontmatter. The fields below are conventions, not all required.

**Standard fields:**

- `state` — `locked` (team truth) or `ephemeral` (working context). Locked files live under `shared/locked/`; ephemeral files live elsewhere under `shared/` or `team-member/{user}/`.
- `lifecycle` — for ephemeral files: `active` (still relevant) or `resolved` (handled, kept for record).
- `type` — kind of content: `reference`, `braindump`, `handoff`, `research`, `design`, `index`, `canonical`, `promoted`.
- `topic` — kebab-case slug matching the filename (after the type prefix, when one is present).
- `author` — username scope owner. Required for `team-member/{user}/` files.
- `updated` — ISO date of last meaningful edit. `/maintenance` flags stale `lifecycle: active` files based on this.

**Index-feeding field:**

- `description` — one-line summary, used verbatim by `workspace-context/index.md` and per-user team-member indexes. When omitted, the index falls back to the first sentence of the body, then the filename slug (with the `braindump_`/`handoff_`/`research_` prefix stripped). Adding a `description:` to a file with a weak fallback is the cheapest way to improve the index.

**Optional confidence marker:**

- `confidence` — `high` | `medium` | `low`. Apply to research, design, and exploration files where the conclusions might still shift. Skip on locked files (locked = high by definition) and on workflow artifacts like handoffs and braindumps. The frontmatter integrity check in `/maintenance` validates the value if present.

**Example for a research file:**

```yaml
---
state: ephemeral
lifecycle: active
type: research
topic: vector-search-evaluation
description: Evaluation of FAISS for workspace-context — concluded NL index is sufficient at our scale.
author: alex
confidence: medium
updated: 2026-04-25
---
```

## Workspace-Context Auto-Generated Files

A single generator at `.claude/scripts/build-workspace-context.mjs` produces three artifacts in one pass:

- `workspace-context/index.md` — navigation catalog of everything under `shared/` (locked files first, then the rest). Imported by the workspace-level `CLAUDE.md`.
- `workspace-context/canonical.md` — verbatim concatenation of `shared/locked/*.md` so team truths are loaded into every session prompt. Also imported by `CLAUDE.md`.
- `workspace-context/team-member/{user}/index.md` — per-user navigation catalog, one per team member. Imported by each user's gitignored `CLAUDE.local.md`.

Gitignored files (e.g. anything matching `local-only-*`) are excluded automatically, and `workspace-context/.indexignore` adds path-prefix excludes for tracked files that shouldn't appear in the shared index (e.g. archived release notes).

```bash
node .claude/scripts/build-workspace-context.mjs --check --root .   # exits 1 if any artifact is stale or missing
node .claude/scripts/build-workspace-context.mjs --write --root .   # regenerate all three
```

`/maintenance` checks staleness in audit mode and regenerates in cleanup mode. Hand edits to `index.md`, `canonical.md`, or any `team-member/{user}/index.md` are overwritten — update source files (or their `description:` frontmatter) instead.
