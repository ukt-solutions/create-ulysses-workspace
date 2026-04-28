---
name: handoff
description: Save workstream state as workspace-context. Use anytime during work to capture progress, decisions, and next steps. Accepts optional name parameter.
---

# Handoff

Save structured workstream state to workspace-context. Usable anytime, any number of times. Per-user (`team-member/{user}/`) is the default scope.

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
- Suggest starting a work session first, or use the helper with `--local-only`

The flows below apply when NOT in an active work session, or when the user explicitly asks for a standalone handoff file.

## Flow: Named

1. Read workspace user identity from `.claude/settings.local.json` (`workspace.user`)
2. Ask: "Should this be user-scoped (default), team-visible, or local-only?"
   - User-scoped (default): `--scope team-member --user {user}`
   - Team-visible: `--scope shared`
   - Local-only: add `--local-only` to either scope
3. Use the centralized helper to compute the path, apply the `handoff_` prefix, and write the file with full frontmatter:

```bash
echo "$BODY" | node .claude/scripts/capture-context.mjs \
  --type handoff \
  --topic {kebab-case-name} \
  --scope team-member \
  --user {workspace.user} \
  --description "{one-line summary}"
```

Pass `--update` to overwrite an existing handoff with the same name (otherwise the helper appends `-2`, `-3`, … to avoid clobbering). The helper prints the absolute path of the written file on stdout — use that path for the commit step.

The body content sent on stdin should follow this template:

```markdown
## Status
{What was accomplished in this session}

## Key Decisions
{Important choices made and their rationale}

## Next Steps
- [ ] {Specific next actions}

## Open Questions
{Unresolved questions, if any}
```

The helper writes the frontmatter (`state: ephemeral`, `lifecycle: active`, `type: handoff`, `topic`, `author`, `updated`). If you need extra fields like `branch:` or `repo:`, append them to the frontmatter after the helper writes (or include them inline in the body).

4. Auto-commit the handoff file alone:
   ```bash
   git add {printed-path}
   git commit -m "handoff: {name}"
   ```

## Flow: No Parameter

1. Analyze the current session: what topics have been discussed?
2. If one clear topic: suggest a name, ask to confirm
3. If multiple topics are conflated: "I see work on {topic-1} and {topic-2}. Split into separate handoffs?"
   - If yes: run the named flow for each topic
   - If no: ask for a single name that covers both
4. Proceed with the named flow for each handoff

## Include task snapshot

If an active session exists (detected via `.claude/.active-session.json`), include a `## Tasks at capture time` section in the handoff body before piping it to `capture-context.mjs`:

```markdown
## Tasks at capture time

- [x] Start work
- [x] Reproduce on iOS Safari
- [ ] Identify race condition
- [ ] Complete work
```

Use the same GFM checkbox format as `session.md`'s `## Tasks` section (just `content` and `status` per task — no `activeForm` field, no blockquote line). Do NOT call `sync-tasks.mjs --write` — handoffs are snapshots, not the canonical store.

## Updating Existing Handoffs

When updating an existing handoff, rewrite it as a fresh snapshot of current understanding (coherent-revisions rule) and pass `--update` to `capture-context.mjs`. Don't append below the old content. The updated handoff should read as if written in one pass reflecting the current state.

The helper updates the `updated` date in frontmatter automatically.

## Notes
- Per-user is the default — `--scope shared` is for content deliberately made team-visible
- Handoffs are always committed individually — never bundled with code commits
- One topic, one file — don't let handoffs become grab-bags
- Name before writing — the name forces you to identify the single topic
- Auto-committing context files without user request is a workflow artifact — this intentionally bypasses the "do not commit unless asked" convention, not the "committed individually" constraint above
