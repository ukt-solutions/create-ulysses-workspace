---
branch: feature/extended-hooks
author: myron
date: 2026-04-01
---

## Open Questions

- Does @shared-context/locked/ directory import work in Claude Code, or do individual files need to be @-imported? Needs verification — fallback is a generated index file.
- PreToolUse hook for repo-write detection: should it block writes to repos/ without a work session, or just warn? How aggressive should nudging be?
- Should the PreCompact hook be more assertive if analytics show low capture rates (compaction-to-capture ratio below 50%)?
- Template settings.json currently has no matcher on SessionStart — verify this fires correctly on all event types (startup, resume) across Claude Code versions.
