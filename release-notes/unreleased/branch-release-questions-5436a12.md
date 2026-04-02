---
branch: chore/spec-v2-rewrite
author: myron
date: 2026-04-01
---

## Open Questions

### Bootstrapping & Development
- New template features aren't available in the dogfood workspace until manually copied. Need a convention for keeping the active workspace in sync during template development.
- Should /migrate have an "update from local template" mode for development workflows?

### Skill Behavior
- Context-discipline rule has intent-to-skill mapping ("let's sync" → /sync). Should this be mandatory instead of optional? Claude missed skill invocations 5 times in one session without it.
- /sync skill exists but needs the dogfood workspace to have it copied. Should /start-work automatically check for new template skills and offer to install them?

### Hooks
- PreToolUse repo-write detection hook reads tool input JSON — needs testing to verify the JSON structure matches what Claude Code actually passes to PreToolUse hooks.
- Session-end hook reads `reason` from stdin JSON — needs verification of the actual SessionEnd hook data format.
- WorktreeCreate hook uses macOS `date -j` syntax — needs Linux compatibility testing.

### Architecture
- Previous session's open questions still apply (from branch-release-questions-6322a80.md) — @shared-context/locked/ import verification, workspace branching convention for teams, release targeting for multi-repo workspaces.
