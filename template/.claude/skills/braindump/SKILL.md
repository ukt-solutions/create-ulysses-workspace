---
name: braindump
description: Capture discussion-heavy topics into shared context. Use when reasoning, exploration, or design rationale should be preserved. Accepts optional name parameter.
---

# Braindump

Capture discussion reasoning, exploration results, and design rationale into shared context. More freeform than /handoff — designed for "why we chose X" content. User-scoped by default.

## Parameters
- `/braindump {name}` — create or update a named braindump
- `/braindump` (no param) — analyze session and suggest name(s)

> **Note:** `/braindump side` has moved to `/aside`. If the user invokes `/braindump side`, redirect them: "The side braindump is now `/aside`. Running it for you." Then invoke the `/aside` skill with their text.

## Session-Aware Behavior

When called within an active work session (the active-session pointer at `.claude/.active-session.json` exists inside the current worktree):

- Default behavior: append reasoning and decisions to the session tracker body at `work-sessions/{session-name}/session.md`
- Add a new section to the tracker body (Context, Exploration, Decisions, Implications) — do NOT touch the frontmatter
- Auto-commit from the workspace root:
  ```bash
  git -C {workspace-root} add work-sessions/{session-name}/session.md
  git -C {workspace-root} commit -m "braindump: update {session-name} tracker"
  ```

When called from the workspace root (no active session):
- Create a `local-only-{name}.md` file (root only allows local-only writes)
- Suggest starting a work session if the braindump is about actionable work

The flows below apply when NOT in an active work session, or when the user explicitly asks for a standalone braindump file.

## Flow: Named

Follows the same naming, scoping (user/team/local-only), and commit flow as `/handoff` but with a different file format:

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

## Flow: Side Braindump (deprecated)

`/braindump side` has been replaced by the `/aside` skill. If invoked:
1. Inform the user: "The side braindump is now `/aside`. Running it for you."
2. Invoke the `/aside` skill with the user's text

## Flow: No Parameter

1. Analyze the current session: what discussion topics are in play?
2. If one clear topic: suggest a name, ask to confirm
3. If multiple topics: "I see discussion about {topic-1} and {topic-2}. Split into separate braindumps?"
4. Proceed with named flow for each

## Updating Existing Braindumps

When updating, rewrite as a fresh snapshot (coherent-revisions rule). The updated braindump should read as if written in one pass.

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

## Notes
- User-scoped is the default
- One topic, one file — don't mix unrelated ideas in one braindump
- Drive-by ideas now use `/aside` instead of `/braindump side`
- Auto-committing context files without user request is a workflow artifact — this intentionally bypasses the "do not commit unless asked" convention
