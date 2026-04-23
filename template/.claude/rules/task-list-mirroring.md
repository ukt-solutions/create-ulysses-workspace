# Task List Mirroring

The Claude Code `TodoWrite` checklist is a live mirror of the workspace lifecycle. The durable backing store is a `## Tasks` section in `session.md`, round-tripped by `.claude/scripts/sync-tasks.mjs`. This rule defines the contract.

## Why

`TodoWrite` is conversation-scoped — it disappears at the end of every chat. To make it useful for multi-chat work sessions, it needs a durable store that survives chat restarts, machine switches, and pause/resume cycles. `session.md` already lives on the session branch and travels with `git push`/`git pull`, so it's the natural home.

## The `## Tasks` schema

Anchored after `## Pre-session context` (if present) and before `## Progress`:

```
## Tasks

> Linked: gh:42 — Auth timeout on mobile

- [x] Start work
- [x] Reproduce on iOS Safari
- [ ] Identify race condition in token refresh
- [ ] Complete work
```

- The heading is exactly `## Tasks`.
- Optional first line is a blockquote `> Linked: {workItem-id} — {issue-title}`. Present iff `workItem:` is set in frontmatter.
- Each task is one checkbox line. Three statuses: `- [ ]` pending, `- [-]` in_progress, `- [x]` completed. No nesting.
- The bookends `Start work` and `Complete work` are always present, at positions 1 and N.

The `- [-]` marker is non-standard GFM — GitHub's web renderer shows it as literal text rather than a checkbox. That's acceptable because `session.md` lives on session branches and is mostly read in editors (where Obsidian, JetBrains, and similar renderers do treat `[-]` as in-progress). The tradeoff buys lossless `in_progress` round-trip across chats.

## Helper invocations

```bash
# Read: emits TodoWrite-shaped JSON.
node .claude/scripts/sync-tasks.mjs --read <session.md>

# Write: takes TodoWrite-shaped JSON on stdin, rewrites the section atomically.
node .claude/scripts/sync-tasks.mjs --write <session.md>
```

The helper enforces bookends on write — Claude doesn't need to remember to include them, and any misplacement is silently corrected.

## When to flush (write to disk)

**Lifecycle moments — always:**
- `/start-work` (blank): seed `## Tasks` with bookends + (if linked) tracker reference.
- `/start-work` (resume): read-only — populate `TodoWrite` from `## Tasks`.
- `/pause-work`: flush before the auto-commit.
- `/complete-work`: flush before release-note synthesis.
- `/handoff`, `/braindump`: include a snapshot of current `TodoWrite` state in the captured artifact.

**Mid-session — after meaningful change:**
- A new task was added.
- A task moved to `completed`.
- A task moved to `in_progress`.

Trivial edits (renaming, reordering) do **not** trigger a flush — they ride on the next lifecycle commit.

## What NOT to do

- Do not edit the `## Tasks` section by hand or with `Edit` — always go through the helper. Manual edits will be overwritten and may miss the bookend invariant.
- Do not add nested checkboxes — `TodoWrite` is flat, and the round-trip ignores nesting.
- Do not omit the bookends — the helper auto-inserts them, but explicit is better than implicit.
- Do not flush every keystroke — that creates pointless file churn. Flush on meaningful change or lifecycle moment.
- Do not flush from inside a subagent — subagents have ephemeral context; only the main agent maintains the canonical `TodoWrite` state for the session.

## Concurrency model

Multi-chat-on-same-session is rare but possible. Each chat maintains its own `TodoWrite`; flushes write the file and the last writer wins. This matches the existing `## Progress` model. If you notice a divergence, the disk version is authoritative — restart your chat to reseed.
