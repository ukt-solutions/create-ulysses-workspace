---
branch: feature/extended-hooks
author: myron
date: 2026-04-01
---

## Open Questions

### Hooks & Detection
- Does @shared-context/locked/ directory import work in Claude Code, or do individual files need to be @-imported? Needs verification — fallback is a generated index file.
- PreToolUse hook for repo-write detection: should it block writes to repos/ without a work session, or just warn? How aggressive should nudging be?
- Should the PreCompact hook be more assertive if analytics show low capture rates (compaction-to-capture ratio below 50%)?
- Template settings.json currently has no matcher on SessionStart — verify this fires correctly on all event types (startup, resume) across Claude Code versions.
- Do memory-related hooks exist in Claude Code? Closest candidates might be PostToolUse on memory writes or FileChanged watcher. Needed for auto-promote feature.
- Can we detect "retroactive branch creation" cleanly — stash changes, create branch, pop stash?

### Architecture & Conventions
- How to handle template updates for teams who forked? Cherry-pick individual files? Git subtree?
- Should agent rules be a separate directory (.claude/agent-rules/) or just regular rules with frontmatter scoping?
- Should /migrate be a 9th skill in the template, or scaffolder-only? Current thinking: both (dual-mode).
- How much of the chat transcript is actually useful for handoff synthesis vs noise?
- Should work sessions have their own IDs separate from git branch names?

### Workflow & Skills
- /complete-work doesn't handle workspace repo changes — only processes project repo branches. How should workspace-level commits (context, rules, hooks) be tracked?
- Release targets repos not workspace — but workspace had ~20 meaningful commits this session. Is "workspace doesn't version" the right call?
- /complete-work should trigger on close-out signals ("let's wrap up", "I'm done"). Rule-based detection or hook?
- When completing work that touched multiple repos, should release notes be per-repo (default), combined, or ask?
- What happens when a discussion session makes repo changes without a formal work session? Accept as work, stash for later, hand off to teammate, or revert?

### Naming & Identity
- Product needs a proper name beyond "create-claude-workspace"
- /stats conflicts with built-in Claude Code command — need alternative name for analytics skill (/health, /pulse, /insights?)
- "Work session" vs "chat session" terminology needs to be consistent across all skills and docs
