# Memory Guidance

Guide Claude's auto-memory system and context capture discipline for this workspace.

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

## Context Capture

- After any design decision with tradeoffs discussed, suggest `/braindump`
- When switching topics mid-session, suggest splitting into separate handoffs
- At natural breakpoints (task completion, PR creation, branch merge), suggest `/handoff`
- When the user says "we decided", "the convention is", "this replaces", or similar decision-signaling phrases, flag it: "That sounds like a decision worth capturing. /braindump?"
- When the user discovers something valuable that the team should know, suggest `/promote`

## Session Awareness

- If 20+ turns have passed without any /handoff or /braindump, flag it: "Long session without capture. Worth preserving anything so far?"
- When PreCompact fires, treat it as urgent — stop and capture before proceeding
- At session end signals, prompt for the appropriate capture skill
