---
branch: feature/persistent-work-sessions
type: feature
author: myron
date: 2026-04-05
---

# Design: Persistent Work Sessions (v0.3.0)

Work sessions become persistent, named entities that span multiple Claude Code chats. A work session has identity, state, and cross-chat continuity. Multiple work sessions can coexist in parallel across different terminal windows.

## Core Concepts

### Work Session

A work session is the lifecycle from /start-work to /complete-work. It spans multiple chat sessions. Each work session gets:

- A **session name** (kebab-case slug derived from the user's description)
- A **branch** (same name used in both project and workspace repos)
- A **workspace worktree** at `repos/{session-name}___wt-workspace/`
- A **project worktree** at `repos/{session-name}___wt-{repo}/`
- A **session marker** at `.claude-scratchpad/.work-session-{session-name}.json`
- An **inflight tracker** at `shared-context/{user}/inflight/session-{session-name}.md`

### Chat Session vs Work Session

- **Chat session**: a single Claude Code conversation. Has a session ID. Ends when you exit.
- **Work session**: spans multiple chat sessions. Tied to branches and worktrees. Persists across chats.

Use "work session" consistently. Bare "session" is ambiguous.

### Workspace Root Model

The workspace root stays on main. It is the launcher — you open Claude Code there to pick or create a work session, then work from the workspace worktree. The root is effectively read-only:

- **Allowed from root:** reading any file, writing `local-only-*` files, writing to `.claude-scratchpad/`
- **Not allowed from root:** writing to shared-context (except local-only), repos, rules, skills, hooks
- **Enforcement:** `repo-write-detection.mjs` hook warns on disallowed writes

All real work happens in workspace worktrees.

## Session Marker Schema

Located at `.claude-scratchpad/.work-session-{session-name}.json`:

```json
{
  "name": "migrate-tool-rewrite",
  "description": "Rewriting the migration module with fresh/update modes",
  "branch": "bugfix/migrate-rewrite",
  "repo": "create-claude-workspace",
  "status": "active",
  "created": "2026-04-05T10:00:00Z",
  "user": "myron",
  "chatSessions": [
    {
      "id": "bd2e3016-...",
      "started": "2026-04-05T10:00:00Z",
      "ended": "2026-04-05T12:30:00Z"
    },
    {
      "id": "a1b2c3d4-...",
      "started": "2026-04-05T14:00:00Z",
      "ended": null
    }
  ]
}
```

**Fields:**
- **name**: session name (kebab-case slug), used as the worktree prefix and marker filename key
- **description**: one-line human summary from the user's "what are you working on"
- **branch**: full branch name including prefix (e.g., `feature/migrate-tool`)
- **repo**: single project repo name — one repo per work session (multi-repo is a future concern)
- **status**: `active` | `paused`
- **created**: ISO timestamp of first /start-work
- **user**: from settings.local.json
- **chatSessions**: array of contributing chats. `ended: null` means currently active.

**Lifecycle:** created by /start-work, updated by hooks (chat join/leave), set to `paused` by /pause-work, deleted by /complete-work.

**Fallback:** if a marker is missing but worktrees and branches exist, /start-work can reconstruct from git state.

**Known limitation:** one project repo per work session. Multi-repo sessions would require changing `repo` to `repos: []` with per-repo worktree tracking. Not in v0.3.0 scope.

## Worktree Naming Convention

Session-centric grouping — the session name comes first, the suffix identifies the type:

```
repos/
  create-claude-workspace/                          # main clone (stays on default branch)
  migrate-tool___wt-workspace/                      # workspace worktree (session)
  migrate-tool___wt-create-claude-workspace/        # project worktree (session)
  auth-refactor___wt-workspace/                     # another session
  auth-refactor___wt-create-claude-workspace/
```

- All worktrees for a session are adjacent in directory listings
- `___wt-workspace` suffix identifies the workspace worktree
- `___wt-{repo-name}` suffix identifies project repo worktrees
- Cleanup is straightforward: delete everything matching `{session-name}___wt-*`

## Inflight Tracker

A living document at `shared-context/{user}/inflight/session-{session-name}.md` that accumulates context throughout the session's life. Fed by three sources:

1. **Skills** — rich context written at natural checkpoints (start-work, handoff, braindump all update it)
2. **SessionEnd hook** — lightweight safety-net entry on clean exit (decisions made, files changed)
3. **History reconstruction** — on resume after unclean exit, /start-work scans message history to fill gaps

The tracker is the canonical "what happened in this work session" document. /complete-work consumes it into release notes. /pause-work writes a final status summary to it.

### History Reconstruction

On /start-work resume:

1. Read session marker's `chatSessions` array
2. For the most recent chat, check if `ended` timestamp exists and matches tracker state
3. Look in `~/.claude/projects/{project-path}/` for message history matching the session ID
4. If there's a gap (last message in history is newer than tracker's last update): uncaptured work exists
5. Scan those messages, generate a summary, append to the inflight tracker
6. Tell user: "Found uncaptured work from your last chat. Updated the session tracker."

## SessionStart Hook

Enhanced `session-start.mjs`:

1. Read all `.work-session-*.json` files from `.claude-scratchpad/`
2. For each, verify worktrees still exist (detect orphaned markers)
3. Present active sessions prominently, before shared context:

```
Workspace: claude-workspace-dev

Active work sessions:
  1. migrate-tool (active, last chat ended 2h ago)
     "Rewriting the migration module with fresh/update modes"
     Branch: bugfix/migrate-rewrite | Repo: create-claude-workspace

  2. auth-refactor (paused 3d ago)
     "Refactoring auth middleware for compliance"
     Branch: feature/auth-refactor | Repo: create-claude-workspace

Use /start-work to resume a session or start new work.
```

4. Register this chat's session ID in the marker if resuming an active session
5. Shared context listed after sessions as secondary reference

## SessionEnd Hook

Enhanced `session-end.mjs`:

1. Read active session marker (if any)
2. Mark this chat's entry with `ended` timestamp
3. Write a lightweight summary entry to the inflight tracker as a safety net
4. Log to session-log.jsonl (existing behavior)

## Repo-Write-Detection Hook

Expanded `repo-write-detection.mjs`:

From workspace root (main):
- Warn on ANY write except `local-only-*` files and `.claude-scratchpad/` files
- Message: "You're on main. Start or resume a work session with /start-work first."

From workspace worktree:
- Check for active session marker (current behavior)
- Warn if no marker found

## PreCompact Smart Capture (#15)

Enhanced `pre-compact.mjs`:

1. Read active session marker
2. If active session: check inflight tracker's last update time
   - If stale: "Context compacting. Session tracker for {name} was last updated {time} ago. Consider /handoff before context is lost."
   - If recently updated: lighter message or skip
3. If no active session: current generic message

## /start-work Skill Changes

### Flow: No Parameter
1. Read session markers from `.claude-scratchpad/`
2. If active sessions exist, present them interactively
3. User picks one → resume flow
4. User says "new" → blank flow

### Flow: Resume
1. Read the selected marker
2. Verify workspace worktree exists at `repos/{session-name}___wt-workspace/`
3. Verify project worktree exists at `repos/{session-name}___wt-{repo}/`
4. If missing, recreate from the branch
5. Register this chat's session ID in the marker
6. Run history reconstruction to catch uncaptured work
7. Tell user: "Resuming {name}. Work from `repos/{session-name}___wt-workspace/`."

### Flow: Blank (new session)
1. Ask "What are you working on?"
2. Generate session name from description (kebab-case slug)
3. Propose branch: `{prefix}/{session-name}`
4. On confirmation, create both worktrees via helper script:
   - `repos/{session-name}___wt-workspace/` — workspace worktree
   - `repos/{session-name}___wt-{repo}/` — project worktree
   - Symlink `repos/` into workspace worktree (`repos/{session}___wt-workspace/repos → ../../`) so project worktrees are accessible via relative paths
5. Create session marker in `.claude-scratchpad/`
6. Create inflight tracker at `shared-context/{user}/inflight/session-{session-name}.md`
7. Register this chat's session ID
8. Tell user: "Work session started. Work from `repos/{session-name}___wt-workspace/`."

### Flow: Retroactive
Detect uncommitted work, offer to formalize into a session. Create worktrees retroactively (stash, branch, pop).

## /pause-work Skill Changes

1. Update session marker: `status: "paused"`, record chat `ended` timestamp
2. Write final status summary to inflight tracker (in `shared-context/{user}/inflight/`)
3. Push both branches (project + workspace)
4. Create draft PRs for both
5. Tell user: "Session paused. Resume anytime with /start-work."
6. No worktree cleanup — session is meant to be resumed

## /complete-work Skill Changes

Steps 1-7 stay mostly the same (detect, rebase, capture, gather, synthesize, consume specs).

### Unified PR Presentation (#13)

Instead of creating PRs separately, present a single unified summary:

```
Work session complete:

PROJECT: create-claude-workspace
  PR #18: feat: persistent work sessions
  Changes: ...
  Release notes: branch-release-notes-{sha}.md

WORKSPACE: claude-workspace-dev
  PR #9: context: persistent-work-sessions session
  Changes: ...

Merge both? [Y/n]
```

If yes: `gh pr merge` both, pull both repos to main, full cleanup.

### Cleanup (expanded)

- Delete session marker
- Remove workspace worktree: `repos/{session-name}___wt-workspace/`
- Remove project worktree: `repos/{session-name}___wt-{repo}/`
- Delete local branches in both repos
- Verify workspace root is still on main

### Orphaned Marker Cleanup

/maintenance cleanup checks for orphaned markers — markers whose branches have been merged or deleted. Removes them. This catches the case where someone merges manually through GitHub without running /complete-work.

## /handoff and /braindump Changes

When called within an active work session, these skills default to updating the inflight tracker rather than creating separate files. The tracker accumulates the session's decisions, reasoning, and progress in one place.

- /handoff within a session → append work state to inflight tracker
- /braindump within a session → append reasoning/decisions to inflight tracker
- /braindump side → still creates a separate local-only file (unrelated to current work)

Outside a session (from workspace root), /braindump creates a `local-only-*` file.

## Memory Guidance Changes

Steer session-relevant observations to the inflight tracker instead of auto-memory:

- Decisions made during this session → inflight tracker (consumed by /complete-work)
- Patterns/corrections that apply beyond this session → auto-memory (persists across sessions)
- Anything already in the inflight tracker → don't also save to auto-memory

## Helper Scripts

Two Node.js scripts in `.claude/hooks/` (or `.claude/scripts/`):

### create-work-session.mjs
Called by /start-work. Creates both worktrees, symlinks repos/, writes session marker, creates inflight tracker. Single invocation replaces ~6 bash calls.

**Arguments:** `--session-name`, `--branch`, `--repo`, `--user`

### cleanup-work-session.mjs
Called by /complete-work. Removes both worktrees, deletes local branches, removes session marker. Single invocation replaces ~5 bash calls.

**Arguments:** `--session-name`, `--repo`

## Rules Changes

### git-conventions.md
Update worktree naming section:
- Old: `{repo-name}___wt-{branch-slug}`
- New: `{session-name}___wt-{type}` where type is `workspace` or `{repo-name}`

### workspace-structure.md
- Document workspace worktrees in directory layout
- Add workspace root write restriction (only `local-only-*` and `.claude-scratchpad/`)
- Update naming conventions for the new worktree format

### memory-guidance.md
- Add guidance to steer session-relevant observations to inflight tracker
- Distinguish session-scoped context (tracker) from cross-session knowledge (auto-memory)

## Scope Boundaries

**In scope:**
- #23 — Session markers, cross-chat continuity, /start-work resume
- #24 — Workspace branching with worktrees (parallel session support)
- #6 — Single-session limitation resolved
- #13 — Unified PR merge workflow in /complete-work
- #15 — PreCompact smart capture (session-aware)

**Out of scope:**
- #25 — Work session detection (auto-formalize via PostToolUse hook)
- #26 — Overtimers (depends on persistent sessions settling)
- #12 — Side braindump as subagent
- #19 — Directory restructure
- Multi-repo work sessions (future, requires schema change)
- Claude Squad session ID integration (platform dependency, works if available)
