---
name: handoff
description: Save workstream state as shared context. Use anytime during work to capture progress, decisions, and next steps. Accepts optional name parameter.
---

# Handoff

Save structured workstream state to shared context. Usable anytime, any number of times. User-scoped by default.

## Parameters
- `/handoff {name}` — create or update a named handoff
- `/handoff` (no param) — analyze session and suggest name(s)

## Session-Aware Behavior

When called within an active work session (the active-session pointer at `.claude/.active-session.json` exists inside the current worktree):

- Default behavior: update the session tracker body at `work-sessions/{session-name}/workspace/session.md`
- Rewrite the tracker's `## Progress` section with current state (coherent-revisions rule)
- Do NOT touch the frontmatter — it's machine state managed by hooks and scripts
- Skip the naming and scoping questions — the tracker is already scoped to this session
- Auto-commit from inside the worktree so the update lands on the session branch:
  ```bash
  cd work-sessions/{session-name}/workspace
  git add session.md
  git commit -m "handoff: update {session-name} tracker"
  ```

When called from the workspace root (no active session):
- Only `local-only-*` files are writable from the root
- Suggest starting a work session first, or create a `local-only-{name}.md` file

The flows below apply when NOT in an active work session, or when the user explicitly asks for a standalone handoff file.

## Flow: Named

1. Read workspace user identity from `.claude/settings.local.json` (`workspace.user`)
2. Check if handoff already exists in `shared-context/{user}/` or `shared-context/` root
3. If exists: read it, prepare to update with current session state
4. If new: prepare to create
5. Ask: "Should this be user-scoped (default), team-visible, or local-only?"
   - User-scoped (default): `shared-context/{user}/{name}.md`
   - Team-visible: `shared-context/{name}.md`
   - Local-only: `shared-context/local-only-{name}.md`
6. Write the handoff file:

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

When updating an existing handoff, rewrite it as a fresh snapshot of current understanding (coherent-revisions rule). Don't append below the old content. The updated handoff should read as if written in one pass reflecting the current state.

Update the `updated` date in frontmatter. Keep the `lifecycle` as-is unless the user indicates a change.

## Notes
- User-scoped is the default — root is only for content deliberately made team-visible
- Handoffs are always committed individually — never bundled with code commits
- One topic, one file — don't let handoffs become grab-bags
- Name before writing — the name forces you to identify the single topic
- Auto-committing context files without user request is a workflow artifact — this intentionally bypasses the "do not commit unless asked" convention, not the "committed individually" constraint above
