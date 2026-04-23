---
branch: feature/todowrite-session-mirror
type: feature
author: myron
date: 2026-04-23
---

## Lifecycle-aware TodoWrite mirror in session.md

Surface the workspace lifecycle in Claude Code's persistent `TodoWrite` checklist. From the moment `/start-work` creates a session, the user sees a live checklist with `Start work` ✓ and `Complete work` ⬜ as bookends, optionally framed by a tracker reference (`> Linked: gh:42 — …`). As discussion produces tasks, items appear between the bookends and update in place. State survives across chats, machines, and pause/resume cycles because the durable backing store is a new `## Tasks` section in `session.md`, round-tripped by a new helper.

### What ships

- **`.claude/scripts/sync-tasks.mjs`** — round-trip helper between TodoWrite JSON and the `## Tasks` markdown section. CLI modes:
  - `--read <session.md>` emits TodoWrite-shaped JSON to stdout
  - `--write <session.md>` consumes JSON on stdin, rewrites the section atomically (temp file + rename)
- **`.claude/rules/task-list-mirroring.md`** — defines the contract: schema, when to flush, what NOT to do.
- **Lifecycle wiring** in five skills:
  - `/start-work` (blank): seeds `## Tasks` with bookends + tracker reference; populates TodoWrite from the seed
  - `/start-work` (resume): reads `## Tasks` and restores TodoWrite, preserving statuses
  - `/pause-work`: flushes current TodoWrite state to `## Tasks` before the auto-commit (new Step 4)
  - `/complete-work`: flushes before release-note synthesis (new Step 4; subsequent steps renumbered)
  - `/handoff`, `/braindump`: include a moment-in-time `## Tasks at capture time` section in their captured artifacts

### Design highlights

- **Bookend invariant.** `Start work` (completed) and `Complete work` (pending) are always present, at positions 1 and N. The helper auto-inserts them when omitted and silently moves them when misplaced — Claude doesn't have to remember to include them.
- **Tracker title resolution.** When `workItem:` is set, the helper calls `tracker.getIssue(id)` to fetch the title and renders `> Linked: gh:42 — Title`. Falls back to bare ID if the tracker is unreachable.
- **Atomic writes.** Helper writes to a temp file in the same directory, then renames. A crash mid-write leaves the original file intact.
- **`[-]` marker for `in_progress` status.** Vanilla GFM checkboxes are binary (`[x]` / `[ ]`), which loses the in-progress signal on round-trip. We adopt the Obsidian/JetBrains convention of `- [-]` for in_progress, accepting that GitHub renders it as literal text — `session.md` mostly lives on session branches and is read in editors anyway. The tradeoff buys lossless round-trip.
- **Mid-session auto-flush.** The new rule instructs Claude to silently call `sync-tasks.mjs --write` after meaningful TodoWrite changes (new task, completion, in-progress transition). Trivial edits ride on the next lifecycle commit.
- **Concurrency.** Multi-chat-on-same-session converges at flush time; last writer wins. Matches the existing `## Progress` model.

### What was verified

- 45 unit tests covering parse, render, bookend invariant, atomic write, CLI, tracker resolution, in_progress round-trip
- End-to-end smoke test against the very session that built the feature
- Subagent test: a fresh agent reading the new SKILL.md correctly identifies the seed step and runs the helper unaided

### Out of scope

- No tracker adapter changes
- No nested sub-tasks (TodoWrite is flat; backing store is flat)
- No new top-level command (`/sync-work` unchanged)
- Multi-chat real-time sync — flushes converge at lifecycle moments only
