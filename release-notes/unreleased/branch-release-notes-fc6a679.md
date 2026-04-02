---
branch: chore/improve-promote-skill
type: chore
author: myron
date: 2026-04-02
---

## Skill improvements — promote redesign, worktree fix, work session markers

Redesigned the /promote skill with a coded table UX (AM1, LOC1, LOR1) showing all candidates from all sources with assessments and recommendations in a single view. Users make bulk decisions in one response. Added drop support for removing stale or redundant entries, not just promoting them.

Fixed /start-work branch creation to use `git branch` instead of `git checkout -b`, preventing the recurring failure where worktree creation was blocked because the branch was "already used by" the main clone.

Added work session marker files (`.claude-scratchpad/.work-session-{slug}`) as lightweight state tracking. /start-work creates the marker, /complete-work removes it, /pause-work preserves it. The repo-write detection hook was rewritten to check for marker existence instead of inferring state from branch names — it now only triggers on worktree writes when no work session marker exists. Multi-session scoping (process IDs, per-chat tracking) is handed off for future design.
