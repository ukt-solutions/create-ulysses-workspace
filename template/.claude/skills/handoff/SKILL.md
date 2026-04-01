---
name: handoff
description: Save workstream state as shared context. Use anytime during work to capture progress, decisions, and next steps. Accepts optional name parameter.
---

# Handoff

Save structured workstream state to shared context. Usable anytime, any number of times.

## Parameters
- `/handoff {name}` — create or update a named handoff
- `/handoff` (no param) — analyze session and suggest name(s)

## Flow: Named

1. Read workspace user identity from `.claude/settings.local.json` (`workspace.user`)
2. Check if `shared-context/{name}.md` or `shared-context/{user}/{name}.md` exists
3. If exists: read it, prepare to update with current session state
4. If new: prepare to create
5. Ask: "Should this be team-visible, user-scoped ({user}/), or local-only?"
   - Team-visible: `shared-context/{name}.md`
   - User-scoped: `shared-context/{user}/{name}.md`
   - Local-only: `shared-context/local-only-{name}.md`
6. Write the handoff file with this format:

```yaml
---
state: ephemeral
lifecycle: active
type: handoff
topic: {name}
branch: {current-branch-if-any}
repo: {current-repo-if-any}
author: {user}
updated: {YYYY-MM-DD}
---

## Status
{What was accomplished in this session}

## Key Decisions
{Important choices made and their rationale}

## Next Steps
- [ ] {Specific next actions}

## Open Questions
{Unresolved questions, if any}
```

7. Auto-commit the handoff file alone:
   ```bash
   git add shared-context/{path-to-file}
   git commit -m "handoff: {name}"
   ```

## Flow: No Parameter

1. Analyze the current session: what topics have been discussed?
2. If one clear topic: suggest a name, ask to confirm
3. If multiple topics are conflated: "I see work on {topic-1} and {topic-2}. Split into separate handoffs?"
   - If yes: run the named flow for each topic
   - If no: ask for a single name that covers both
4. Proceed with the named flow for each handoff

## Updating Existing Handoffs

When updating an existing handoff:
- Preserve the existing Key Decisions and Open Questions (append, don't replace)
- Update the Status section with new progress
- Update the Next Steps with current state
- Update the `updated` date in frontmatter
- Keep the `lifecycle` as-is unless the user indicates a change
