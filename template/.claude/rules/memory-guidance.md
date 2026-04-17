# Memory Guidance

Guide Claude's auto-memory system for this workspace.

## What to Auto-Remember

When working in this workspace, pay attention to and save memories about:
- Architecture decisions and their rationale
- Patterns that caused bugs or confusion
- User corrections about project conventions
- External system URLs, credentials locations, API quirks
- Workarounds for tooling issues

## What NOT to Auto-Remember

- Temporary debugging state
- File contents (re-read them instead)
- Anything already captured in a shared-context file
- Anything documented in .claude/rules/

## Session-Scoped vs Cross-Session

When a work session is active:
- Decisions and progress from this session → update the session tracker body at `work-sessions/{name}/workspace/session.md` (consumed by /complete-work)
- Patterns, corrections, and insights that apply beyond this session → auto-memory (persists across all sessions)
- Don't duplicate: if something is already in the session tracker, don't also save it to auto-memory
