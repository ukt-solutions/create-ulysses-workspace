---
name: braindump
description: Capture discussion-heavy topics into shared context. Use when reasoning, exploration, or design rationale should be preserved. Accepts optional name parameter.
---

# Braindump

Capture discussion reasoning, exploration results, and design rationale into shared context. More freeform than /handoff — designed for "why we chose X" content.

## Parameters
- `/braindump {name}` — create or update a named braindump
- `/braindump` (no param) — analyze session and suggest name(s)

## Flow

Follows the same naming, scoping (team/user/local-only), and commit flow as `/handoff` but with a different file format:

```yaml
---
state: ephemeral
lifecycle: active
type: braindump
topic: {name}
author: {user}
updated: {YYYY-MM-DD}
---

## Context
{What prompted this discussion}

## Exploration
{What options were considered, what was researched}

## Decisions
{What was decided and why — include tradeoffs that were weighed}

## Implications
{What this decision means for future work}
```

## Key Differences from /handoff
- `/handoff` is structured around work state (branch, status, next steps)
- `/braindump` is structured around reasoning (context, exploration, decisions, implications)
- Use `/handoff` when you're tracking a workstream
- Use `/braindump` when you're capturing a discussion or decision

## Auto-commit
Same as `/handoff` — commit the file alone:
```bash
git add shared-context/{path-to-file}
git commit -m "braindump: {name}"
```
