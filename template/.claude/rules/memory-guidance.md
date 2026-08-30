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
- Anything already captured in a workspace-context file
- Anything documented in .claude/rules/

## Session-Scoped vs Cross-Session

When a work session is active:
- Decisions and progress from this session → update the session tracker body at `work-sessions/{name}/workspace/session.md` (consumed by /complete-work)
- Patterns, corrections, and insights that apply beyond this session → auto-memory (persists across all sessions)
- Don't duplicate: if something is already in the session tracker, don't also save it to auto-memory

## Where durable content goes

Four destinations, in increasing reach. Pick the narrowest one that works.

| destination | for |
|---|---|
| auto-memory | machine-local preferences and corrections; not shared, not reviewable |
| `team-member/{user}/` | one person's working context |
| `shared/` | team-visible reference that does not need to be always-loaded |
| `shared/locked/` | canonical team truths, loaded verbatim into every session |

**The canonical test.** Canonical should describe what *is* and what *to do*, not what *to
think*. Before locking anything, ask:

> If Claude read this for the first time during a session about an unrelated topic, would it
> (a) help frame the problem correctly, or (b) push Claude toward a particular answer to a
> question that hasn't been asked yet?

(a) is canonical. (b) is `shared/` at most, more often `team-member/{user}/`. Pre-loaded
conclusions in always-loaded context don't read as opinions to Claude — they read as ground
truth, and they frame what Claude considers before the question is asked.

Every locked file is a permanent cost on every session in this workspace. Weigh that before
adding one.

For the frontmatter schema, the generator invocations, and the full belongs/doesn't-belong
lists behind the test, invoke the `context-placement` skill.
