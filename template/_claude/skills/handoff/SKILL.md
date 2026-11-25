---
name: handoff
description: Save workstream state as workspace-context. Use anytime during work to capture progress, decisions, and next steps. Accepts optional name parameter.
---

# Handoff

Save structured workstream state to workspace-context. Usable anytime, any number of times. Per-user (`team-member/{user}/`) is the default scope.

## Parameters
- `/handoff {name}` — create or update a named handoff
- `/handoff` (no param) — analyze session and suggest name(s)

## Lifecycle-Aware Behavior

> **Quoting.** Command values go in single quotes, and a `'` inside a value is written `'\''`: chat text in double quotes would let `$(…)` or backticks run before the command starts.

When called within an active work session (the active-session pointer at `.claude/.active-session.json` exists inside the current worktree):

- Default behavior: update the session tracker body at `work-sessions/{session-name}/workspace/session.md`
- Rewrite the tracker's `## Progress` section with current state (coherent-revisions rule)
- Do NOT touch the frontmatter — it's machine state managed by hooks and scripts
- Skip the naming and scoping questions — the tracker is already scoped to this session
- Auto-commit from inside the worktree so the update lands on the session branch:
  ```bash
  cd 'work-sessions/{session-name}/workspace'
  git add session.md
  git commit -m 'handoff: update {session-name} tracker'
  ```

Under the task model — `workspace.sessionModel` is `"task"` (the SessionStart hook's `Workspace config (workspace.json):` line carries it; read `workspace.json` when that line is not in context) AND the SessionStart hook injected a `Chat record:` line (`{chat}` is its name):

- Default behavior: write `handoff_{topic}.md` directly into that chat's drawer at `workspace-scratchpad/chats/{chat}/` — the drawer sits outside `workspace-context/`, so `capture-context.mjs` is not involved
- No commit for drawer writes: the drawer is gitignored and machine-local; `/complete-work` lists it and asks what to promote into `workspace-context/`
- While a task is active, add `workItem: {id}` to the file's frontmatter: `/complete-work` offers a drawer item only to the task that owns it, so the tag keeps this capture out of another task's promotion list

When called from the workspace root with no active session — every other case, including a `sessionModel: "session"` workspace (the `Chat record:` line is injected in every chat, so it alone does not select the drawer):

- Use `--local-only` so the captured file is gitignored (the root only allows local-only writes), landing in `team-member/{user}/`
- If the task model applies but the `Chat record:` line is absent, say the drawer destination is unavailable for that reason
- Suggest starting work (`/start-work`) first if the handoff is about actionable work

The flows below apply when NOT in an active work session, or when the user explicitly asks for a standalone handoff file.

## Flow: Named

A handoff is tracked only when it is written into a worktree of the workspace repo, because only a worktree is on a branch of its own. Everywhere else it is local-only: the workspace root is the launcher, it stays on the repo's default branch, only `local-only-*` files are written there, and none of them is committed.

Two worktrees count as **the worktree**:

- a task's workspace-repo worktree — `{launcher-root}/.claude/worktrees/{slug}/`, where `{slug}` is the task's branch with `/` replaced by `-`. It is this chat's when the chat's record holds that task with `repo: "."`.
- a session's workspace worktree — `work-sessions/{session-name}/workspace/`, for a chat running inside it.

A chat running inside either is already there; that directory is the `Workspace root:` line the SessionStart hook injects. A chat at the workspace root has a worktree only through its own task: `node .claude/scripts/task-worktree.mjs --root . --detect --chat '{chat}'` lists the chat's tasks with their `branch` and `repo`, and an entry with `repo: "."` names one — ask which when several do. `{chat}` is the name on the `Chat record:` line the hook injects. With no worktree, the capture stays local-only.

1. Read workspace user identity from `.claude/settings.local.json` (`workspace.user`).
2. Scope. Per-user is the default: `--scope team-member --user {user}`. In a worktree, `--scope shared` (dropping `--user`) makes the capture team-visible, and keeping `--local-only` keeps it gitignored. At the workspace root no scope is team-visible, because the file is gitignored wherever it lands: keep the default there, and leave team visibility to `/promote`.
3. Use the centralized helper to compute the path, apply the `handoff_` prefix, and write the file with full frontmatter. `--root` is what decides where the capture goes. This is the root form, for when there is no worktree:

```bash
node .claude/scripts/capture-context.mjs \
  --root . \
  --type handoff \
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

Pass `--update` to overwrite an existing handoff with the same name (otherwise the helper appends `-2`, `-3`, … to avoid clobbering). The helper prints the absolute path of the written file on stdout — the path a tracked handoff is committed by.

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

4. Commit a tracked capture from inside its worktree. The commands run against the worktree with `-C` because from the workspace root `git add` cannot reach a path under `.claude/worktrees/` or `work-sessions/`: the launcher's `.gitignore` covers both. A local-only capture is never committed — it is gitignored, so there is nothing to add.
   ```bash
   git -C '{worktree}' add '{printed-path}'
   git -C '{worktree}' commit -m 'handoff: {name}'
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

Pass the same flags as the original write — `--root`, and `--local-only` unless the handoff is tracked. The helper finds the existing file by the path those flags produce, so a root capture updated without `--local-only` would look for the tracked name instead and miss the file.

The helper updates the `updated` date in frontmatter automatically.

## Notes
- Per-user is the default — `--scope shared` is for content deliberately made team-visible
- A tracked handoff is always committed individually — never bundled with code commits
- One topic, one file — don't let handoffs become grab-bags
- Name before writing — the name forces you to identify the single topic
- Auto-committing a tracked capture without user request is a workflow artifact — this intentionally bypasses the "do not commit unless asked" convention, not the "committed individually" constraint above, and never applies at the workspace root
