---
branch: chore/spec-v2-rewrite
type: chore
author: myron
date: 2026-04-01
---

## Spec v2 Implementation — Skills, Hooks, Rules, and Migration

Comprehensive update aligning the template with spec v2, incorporating 20 design changes discovered during dogfooding.

Rewrote all six core workflow skills to support dual-repo operations: /start-work now branches both the project repo (with worktree) and the workspace repo using the same branch name for traceability, with retroactive formalization support for mid-session starts and stale worktree detection. /complete-work now processes both repos — synthesizing release notes in the project repo and resolving inflight context in the workspace repo, with formal three-source reading (spec + handoffs + commits) before synthesis. /pause-work pushes both repos with no-remote handling. /release targets repos individually (configurable via releaseMode in workspace.json) and synthesizes workspace context alongside.  /handoff and /braindump now default to user-scoped context with capture-time cross-checking for staleness and contradictions, and /braindump supports a "side" variant for capturing unrelated ideas without derailing work.

Added three new skills: /sync for pushing both repos without ceremony (no PR, no lifecycle changes), /audit for on-demand context integrity checking (cross-references, frontmatter validation, git state, context health metrics), and /migrate for converting existing workspaces to the template or updating from newer template versions with selective component installation.

Added three new hooks: a PreToolUse repo-write detection hook that warns when writing to project repos on default branches without an active work session, a SessionEnd hook that logs session summaries to session-log.jsonl for analytics, and a WorktreeCreate hook that scans for stale worktrees when creating new ones.

Added four new optional rules: context-discipline (push captures at breakpoints, map user intent to skills), scope-guard (detect and push back on scope creep), token-economics (cost-conscious model selection and context efficiency), and agent-rules (enforce conventions for subagent behavior).

Updated the CLAUDE.md template with /sync and /audit in the skills list, the workspace.json template with greeting and releaseMode fields, and the scaffolder prompts to include the new optional rules. Added --migrate flag to the scaffolder CLI with a migration module for converting existing workspaces.
