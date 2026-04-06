# The Release Cycle

The release cycle is how accumulated work becomes a versioned artifact. During development, each completed work session deposits release notes into an `unreleased/` directory. At release time, those notes are combined into a versioned document, open questions are resolved, and ephemeral shared context is synthesized into team truths. The cycle keeps the workspace from accumulating stale context indefinitely.

This chapter traces the full pipeline from branch work to versioned release.

---

## The Pipeline

Release notes flow through four stages:

```
Branch work → unreleased/ → versioned release → archive/
```

**Stage 1: Branch work.** During a work session, you write code, make commits, capture context. The inflight tracker accumulates progress. Specs and plans live in the worktree.

**Stage 2: Unreleased.** When `/complete-work` finalizes a session, it synthesizes the accumulated material into two files: `branch-release-notes-{commit}.md` (the narrative) and `branch-release-questions-{commit}.md` (open questions). These land in `release-notes/unreleased/` in the project repo.

**Stage 3: Versioned release.** When you run `/release`, it reads all unreleased notes, combines them into a single `v{version}.md` document, resolves open questions, and commits the result. This is the surviving artifact — the definitive record of what shipped in this version.

**Stage 4: Archive.** The consumed branch notes move to `release-notes/archive/v{version}/`. They are preserved for audit but no longer active.

## How /complete-work Synthesizes

When a session completes, `/complete-work` gathers material from four sources:

1. **The inflight tracker** — accumulated progress, decisions, and reasoning from the session
2. **Branch-scoped specs and plans** — `design-*.md` and `plan-*.md` files in the worktree
3. **Handoffs** — shared context entries referencing this branch
4. **The commit log** — what actually changed, commit by commit

From these sources, it writes a coherent narrative — not a concatenation of notes, but a fresh synthesis written from scratch per the coherent-revisions rule. The release notes describe what was built and why, not the mechanics of how the session proceeded.

The branch-release-questions file captures only genuinely open questions — things that were not resolved during implementation. Design tradeoffs that were settled, bugs that were fixed, approaches that were rejected — these are not open questions.

After writing the release notes, the skill consumes the branch-scoped sources. Specs and plans are removed from the worktree (their content now lives in the release notes). The inflight tracker is removed (its content was synthesized). The release notes are the surviving artifacts.

## How /release Works

The `/release` skill is a project-repo operation — each repo has its own release cadence. When invoked:

1. **Read unreleased notes.** All `branch-release-notes-*.md` and `branch-release-questions-*.md` files in `release-notes/unreleased/`.

2. **Group by type.** Features first, then fixes, then maintenance. Within each group, ordered chronologically.

3. **Resolve open questions.** Each question from the branch-release-questions files gets one of three treatments: answer it (remove from the release), defer it (move to a "Known Issues" section), or discard it (no longer relevant).

4. **Synthesize the release document.** Write `release-notes/v{version}.md` — a coherent narrative combining all branch notes. Features, fixes, maintenance, known issues, contributors. Written from scratch, not concatenated.

5. **Archive consumed notes.** Move branch-release files to `release-notes/archive/v{version}/`.

6. **Synthesize shared context.** Process ephemeral shared context entries that are marked resolved. Merge them into existing locked entries, combine them into new locked entries, or remove them. This is how accumulated session knowledge gets distilled into durable team truths.

## The Ephemeral Cleanup Pattern

The release cycle is the workspace's natural garbage collector. Without it, shared context would grow indefinitely — every braindump, every handoff, every session tracker would accumulate until the workspace became noisy and stale.

The cleanup works in layers:

**Branch-scoped artifacts** (specs, plans, inflight trackers) are consumed by `/complete-work` when a session finalizes. They do not survive past the session that created them.

**Unreleased notes** are consumed by `/release` when a version is cut. They are archived, not deleted — preserved for audit but no longer in the active pipeline.

**Ephemeral shared context** is synthesized by `/release` into locked entries. An ephemeral braindump about authentication design becomes a locked entry about the team's authentication architecture. The ephemeral is removed; the locked entry persists.

**User-scoped leftovers** are the individual's responsibility after a release. `/promote` helps — it scans personal context and recommends what to promote, keep, or discard. But the action is yours.

The principle: **every piece of context has a natural expiration.** Branch artifacts expire at session completion. Unreleased notes expire at release. Ephemerals expire at synthesis. Nothing accumulates without a cleanup mechanism.

## Version Numbering

Versions are assigned at release time, not pre-planned. The convention:

- **Patch** (0.x.**Y**): Bug fixes, design debt, small improvements. No new skills, no schema changes.
- **Minor** (0.**X**.0): New features or significant template changes. May add skills, hooks, or workspace.json fields.
- **Major** (**X**.0.0): Breaking changes to conventions, schema, or skill interfaces.

The version number describes what shipped, not when it was planned. A feature you expected to be a minor might turn out to be a patch if the actual change was small. The milestone plan uses expected version numbers for readability, but the actual number comes from the work that shipped.

## Release Notes Structure

A versioned release document follows this structure:

```markdown
# v1.2.0 Release Notes

**Date:** 2026-04-06

## Features
Coherent narrative of what was added.

## Fixes
What was broken and how it was fixed.

## Maintenance
Refactoring, documentation, tooling changes.

## Known Issues
Deferred questions from development.

## Contributors
Who contributed to this release.
```

The archive directory preserves the raw branch notes that fed this document:

```
release-notes/
├── v1.2.0.md                          # Versioned release document
├── unreleased/                         # Next version's branch notes
└── archive/
    └── v1.2.0/
        ├── branch-release-notes-abc123.md
        ├── branch-release-notes-def456.md
        └── branch-release-questions-abc123.md
```

---

## Key Takeaways

- Release notes flow from branch work through unreleased/ to a versioned document, then archive.
- `/complete-work` synthesizes session material into branch release notes and consumes the sources.
- `/release` combines unreleased notes into a version, resolves questions, and synthesizes shared context.
- The release cycle is the natural cleanup mechanism — every context artifact has an expiration point.
- Versions are assigned at release time based on what shipped, not pre-planned.
