---
name: braindump
description: Capture discussion-heavy topics into workspace-context. Use when reasoning, exploration, or design rationale should be preserved. Accepts optional name parameter.
---

# Braindump

Capture discussion reasoning, exploration results, and design rationale into workspace-context. More freeform than /handoff — designed for "why we chose X" content. Per-user (`team-member/{user}/`) is the default scope.

## Parameters
- `/braindump {name}` — create or update a named braindump
- `/braindump` (no param) — analyze session and suggest name(s)

> **Note:** `/braindump side` has moved to `/aside`. If the user invokes `/braindump side`, redirect them: "The side braindump is now `/aside`. Running it for you." Then invoke the `/aside` skill with their text.

## Session-Aware Behavior

When called within an active work session (the active-session pointer at `.claude/.active-session.json` exists inside the current worktree):

- Default behavior: append reasoning and decisions to the session tracker body at `work-sessions/{session-name}/workspace/session.md`
- Add a new section to the tracker body (Context, Exploration, Decisions, Implications) — do NOT touch the frontmatter
- Auto-commit from inside the worktree so the update lands on the session branch:
  ```bash
  cd work-sessions/{session-name}/workspace
  git add session.md
  git commit -m "braindump: update {session-name} tracker"
  ```

When called from the workspace root (no active session):
- Use `--local-only` so the captured file is gitignored (the root only allows local-only writes)
- Suggest starting a work session if the braindump is about actionable work

The flows below apply when NOT in an active work session, or when the user explicitly asks for a standalone braindump file.

## Flow: Named

Use the centralized `capture-context.mjs` helper — it computes the path, applies the `braindump_` prefix, and writes the frontmatter so this skill doesn't have to:

```bash
echo "$BODY" | node .claude/scripts/capture-context.mjs \
  --type braindump \
  --topic {kebab-case-name} \
  --scope team-member \
  --user {workspace.user} \
  --description "{one-line summary}"
```

Add `--scope shared` (and drop `--user`) to put the file in `workspace-context/shared/` for team visibility. Add `--local-only` to keep it gitignored. Add `--update` to overwrite an existing file with the same name; without it, the helper appends `-2`, `-3`, etc. on collision.

The body content sent on stdin should follow this template:

```markdown
## Context
{What prompted this discussion}

## Exploration
{What options were considered, what was researched}

## Decisions
{What was decided and why — include tradeoffs that were weighed}

## Implications
{What this decision means for future work}
```

The helper writes the frontmatter (`state: ephemeral`, `lifecycle: active`, `type: braindump`, `topic`, `author`, `updated`) and prints the absolute path on stdout so the skill can `git add` and commit it.

## Flow: Side Braindump (deprecated)

`/braindump side` has been replaced by the `/aside` skill. If invoked:
1. Inform the user: "The side braindump is now `/aside`. Running it for you."
2. Invoke the `/aside` skill with the user's text

## Flow: No Parameter

1. Analyze the current session: what discussion topics are in play?
2. If one clear topic: suggest a name, ask to confirm
3. If multiple topics: "I see discussion about {topic-1} and {topic-2}. Split into separate braindumps?"
4. Proceed with named flow for each

## Include task snapshot

If an active session exists (detected via `.claude/.active-session.json`), include a `## Tasks at capture time` section in the braindump body before piping it to `capture-context.mjs`:

```markdown
## Tasks at capture time

- [x] Start work
- [x] Reproduce on iOS Safari
- [ ] Identify race condition
- [ ] Complete work
```

Use the same GFM checkbox format as `session.md`'s `## Tasks` section (just `content` and `status` per task — no `activeForm` field, no blockquote line). Do NOT call `sync-tasks.mjs --write` — braindumps are snapshots, not the canonical store.

## Updating Existing Braindumps

When updating, rewrite as a fresh snapshot (coherent-revisions rule) and pass `--update` to `capture-context.mjs`. The updated braindump should read as if written in one pass.

## Key Differences from /handoff
- `/handoff` is structured around work state (branch, status, next steps)
- `/braindump` is structured around reasoning (context, exploration, decisions, implications)
- Use `/handoff` when you're tracking a workstream
- Use `/braindump` when you're capturing a discussion or decision

## Auto-commit
Use the path that `capture-context.mjs` printed:
```bash
git add {printed-path}
git commit -m "braindump: {name}"
```

## Notes
- Per-user (`team-member/{user}/`) is the default scope
- One topic, one file — don't mix unrelated ideas in one braindump
- Drive-by ideas now use `/aside` instead of `/braindump side`
- Auto-committing context files without user request is a workflow artifact — this intentionally bypasses the "do not commit unless asked" convention
