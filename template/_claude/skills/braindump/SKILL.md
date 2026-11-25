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

## Lifecycle-Aware Behavior

> **Quoting.** Command values go in single quotes, and a `'` inside a value is written `'\''`: chat text in double quotes would let `$(…)` or backticks run before the command starts.

When called within an active work session (the active-session pointer at `.claude/.active-session.json` exists inside the current worktree):

- Default behavior: append reasoning and decisions to the session tracker body at `work-sessions/{session-name}/workspace/session.md`
- Add a new section to the tracker body (Context, Exploration, Decisions, Implications) — do NOT touch the frontmatter
- Auto-commit from inside the worktree so the update lands on the session branch:
  ```bash
  cd 'work-sessions/{session-name}/workspace'
  git add session.md
  git commit -m 'braindump: update {session-name} tracker'
  ```

Under the task model — `workspace.sessionModel` is `"task"` (the SessionStart hook's `Workspace config (workspace.json):` line carries it; read `workspace.json` when that line is not in context) AND the SessionStart hook injected a `Chat record:` line (`{chat}` is its name):

- Default behavior: write `braindump_{topic}.md` directly into that chat's drawer at `workspace-scratchpad/chats/{chat}/` — the drawer sits outside `workspace-context/`, so `capture-context.mjs` is not involved
- No commit for drawer writes: the drawer is gitignored and machine-local; `/complete-work` lists it and asks what to promote into `workspace-context/`
- While a task is active, add `workItem: {id}` to the file's frontmatter: `/complete-work` offers a drawer item only to the task that owns it, so the tag keeps this capture out of another task's promotion list

When called from the workspace root with no active session — every other case, including a `sessionModel: "session"` workspace (the `Chat record:` line is injected in every chat, so it alone does not select the drawer):

- Use `--local-only` so the captured file is gitignored (the root only allows local-only writes), landing in `team-member/{user}/`
- If the task model applies but the `Chat record:` line is absent, say the drawer destination is unavailable for that reason
- Suggest starting work (`/start-work`) if the braindump is about actionable work

The flows below apply when NOT in an active work session, or when the user explicitly asks for a standalone braindump file.

## Flow: Named

A braindump is tracked only when it is written into a worktree of the workspace repo, because only a worktree is on a branch of its own. Everywhere else it is local-only: the workspace root is the launcher, it stays on the repo's default branch, only `local-only-*` files are written there, and none of them is committed.

Two worktrees count as **the worktree**:

- a task's workspace-repo worktree — `{launcher-root}/.claude/worktrees/{slug}/`, where `{slug}` is the task's branch with `/` replaced by `-`. It is this chat's when the chat's record holds that task with `repo: "."`.
- a session's workspace worktree — `work-sessions/{session-name}/workspace/`, for a chat running inside it.

A chat running inside either is already there; that directory is the `Workspace root:` line the SessionStart hook injects. A chat at the workspace root has a worktree only through its own task: `node .claude/scripts/task-worktree.mjs --root . --detect --chat '{chat}'` lists the chat's tasks with their `branch` and `repo`, and an entry with `repo: "."` names one — ask which when several do. `{chat}` is the name on the `Chat record:` line the hook injects. With no worktree, the capture stays local-only.

Use the centralized `capture-context.mjs` helper — it computes the path, applies the `braindump_` prefix, and writes the frontmatter so this skill doesn't have to. `--root` is what decides where the capture goes. This is the root form, for when there is no worktree:

```bash
node .claude/scripts/capture-context.mjs \
  --root . \
  --type braindump \
  --topic '{kebab-case-name}' \
  --scope team-member \
  --user {workspace.user} \
  --description '{one-line summary}' \
  --local-only <<'BODY'
{body}
BODY
```

For a tracked capture, replace `--root .` and `--local-only` with `--root '{worktree}'`.

The body goes in on stdin through the quoted heredoc (`<<'BODY'`), so backticks and `$` in it stay literal — never `echo "…" |`. Use another delimiter if `BODY` occurs on a line of its own in the body.

Per-user is the default scope: `--scope team-member --user {user}`. In a worktree, `--scope shared` (dropping `--user`) makes the capture team-visible, and keeping `--local-only` keeps it gitignored. At the workspace root no scope is team-visible, because the file is gitignored wherever it lands: keep the default there, and leave team visibility to `/promote`. Add `--update` to overwrite an existing file with the same name; without it, the helper appends `-2`, `-3`, etc. on collision.

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

The helper writes the frontmatter (`state: ephemeral`, `lifecycle: active`, `type: braindump`, `topic`, `author`, `updated`) and prints the absolute path on stdout — the path a tracked braindump is committed by.

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

Pass the same flags as the original write — `--root`, and `--local-only` unless the braindump is tracked. The helper finds the existing file by the path those flags produce, so a root capture updated without `--local-only` would look for the tracked name instead and miss the file.

## Key Differences from /handoff
- `/handoff` is structured around work state (branch, status, next steps)
- `/braindump` is structured around reasoning (context, exploration, decisions, implications)
- Use `/handoff` when you're tracking a workstream
- Use `/braindump` when you're capturing a discussion or decision

## Auto-commit

A tracked braindump — one written into the worktree — is committed from inside it. The commands run against the worktree with `-C` because from the workspace root `git add` cannot reach a path under `.claude/worktrees/` or `work-sessions/`: the launcher's `.gitignore` covers both.

```bash
git -C '{worktree}' add '{printed-path}'
git -C '{worktree}' commit -m 'braindump: {name}'
```

A local-only capture is never committed — it is gitignored, so there is nothing to add at the workspace root.

## Notes
- Per-user (`team-member/{user}/`) is the default scope
- One topic, one file — don't mix unrelated ideas in one braindump
- Drive-by ideas now use `/aside` instead of `/braindump side`
- Auto-committing a tracked capture without user request is a workflow artifact — this intentionally bypasses the "do not commit unless asked" convention, and never applies at the workspace root
