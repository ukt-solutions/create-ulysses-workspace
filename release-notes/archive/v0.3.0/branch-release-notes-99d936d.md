---
branch: feature/persistent-work-sessions
type: feature
author: myron
date: 2026-04-05
---

## Persistent Work Sessions

Work sessions are now persistent, named entities that span multiple Claude Code chats. Each session has identity, state, and cross-chat continuity. Multiple sessions can run in parallel across different terminal windows.

### Workspace worktree model

The workspace root stays on main and serves as the launcher. All real work happens in workspace worktrees. Each work session creates two worktrees — one for the workspace repo and one for the project repo — using session-centric naming (`{session-name}___wt-workspace` and `{session-name}___wt-{repo}`). This replaces the old `{repo}___wt-{branch}` convention. The root is effectively read-only: only `local-only-*` files and `.claude-scratchpad/` are writable from main.

### Session markers and cross-chat continuity

Session state is tracked in `.claude-scratchpad/.work-session-{name}.json` markers containing the session name, description, branch, repo, status, and an array of contributing chat sessions with their IDs and timestamps. The SessionStart hook surfaces active sessions when opening Claude at the workspace root. The SessionEnd hook marks chats as ended and writes safety-net entries to the inflight tracker.

### Inflight tracker

Each session gets a living document at `shared-context/{user}/inflight/session-{name}.md` that accumulates context throughout the session's life. Skills update it at natural checkpoints. The SessionEnd hook appends a safety entry on clean exits. On resume, `/start-work` checks for uncaptured work by scanning message history files and filling gaps in the tracker.

### Helper scripts

Two Node.js scripts reduce token usage by consolidating mechanical sequences into single invocations. `create-work-session.mjs` creates both worktrees, symlinks, markers, and the inflight tracker. `cleanup-work-session.mjs` removes worktrees, branches, and markers.

### Unified PR workflow

`/complete-work` now presents both PRs (project + workspace) as a unified summary with a single "Merge both?" approval. One confirmation merges both, pulls both repos, and runs full cleanup.

### Session-aware hooks

The PreCompact hook now checks the inflight tracker's staleness before nudging — if the tracker was recently updated, the message is lighter. The repo-write-detection hook enforces workspace root restrictions, warning on any writes outside `local-only-*` and `.claude-scratchpad/` from main.

### Skill changes

`/start-work` was rewritten for persistent sessions with resume, blank, and retroactive flows. `/pause-work` now updates session markers and writes to the inflight tracker. `/handoff` and `/braindump` default to updating the inflight tracker when called within a session, rather than creating separate files.

### Rule updates

`git-conventions.md` uses the new worktree naming convention. `workspace-structure.md` documents workspace worktrees and the root write restriction. `memory-guidance.md` distinguishes session-scoped context (inflight tracker) from cross-session knowledge (auto-memory).
