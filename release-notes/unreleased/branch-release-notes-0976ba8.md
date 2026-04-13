---
branch: feature/worksessions-refactor
type: feature
author: myron
date: 2026-04-13
---

## Work-Sessions Folder Refactor

Each work session is now a single self-contained folder on disk. The whole session — its workspace worktree, its nested project worktrees, its tracker, its spec, its plan — lives inside `work-sessions/{name}/` and is torn down in one step when the session completes. The old layout scattered session state across three locations (`repos/{session}___wt-*/`, `.claude-scratchpad/.work-session-*.json`, and `shared-context/{user}/inflight/`) and relied on a `repos/` symlink inside every workspace worktree to make paths resolve. Both the scatter and the symlink are gone.

### Why this was worth doing

The old model accumulated real cognitive debt. The `repos/` symlink was the source of the destructive v0.5.1 gitignore bug that silently replaced entire clone directories when a worktree was committed and pulled. The three-location scatter meant there was no clean unit of "this is one session, here is everything for it" — debugging a stuck session meant checking `repos/`, `.claude-scratchpad/`, and `shared-context/{user}/inflight/` and piecing it together. The `{session}___wt-{type}` naming convention only existed because worktrees were siblings in a flat directory. And the hidden `.claude-scratchpad/` name was modeled reflexively on `.claude/` with no functional reason to be hidden.

All of that is now resolved at once, and the new on-disk shape aligns with what the future desktop app will need to render — one folder per session, everything inside.

### The new layout

A session folder looks like this:

```
work-sessions/fix-auth/
├── workspace/                    # Workspace worktree
│   └── repos/                    # Real directory (no symlink)
│       └── my-app/               # Project worktree on the session branch
├── session.md                    # Tracked — frontmatter + body
├── design-auth.md                # Tracked — session spec
└── plan-auth.md                  # Tracked — session plan
```

The `session.md`, `design-*.md`, and `plan-*.md` files are tracked in git via a gitignored-folder-with-tracked-file-exception pattern. Everything else under `work-sessions/` is local — worktrees are recreated on resume, not pulled. Pushing the workspace branch carries the tracker, spec, and plan across machines; the worktrees stay per-machine.

The source clones still live at `repos/{repo}/` at the workspace root — they're workspace-scoped state, not session-scoped, and mixing them under `work-sessions/` would obscure the lifecycle distinction.

### Unified session tracker

`session.md` replaces both the old JSON marker and the old markdown inflight tracker. One file, one source of truth. Machine state (status, branch, repos list, chat session log) lives in YAML frontmatter; human content (progress, decisions, captured reasoning from `/handoff` and `/braindump`) lives in the body. Scripts and hooks read and write the frontmatter through a new helper at `.claude/lib/session-frontmatter.mjs` that is lossless by construction — it rewrites only the fields that actually changed, leaving every other byte of the file untouched. The `/handoff` and `/braindump` skills, when run during an active session, now update the tracker body rather than writing to the deleted `shared-context/{user}/inflight/` directory.

The parser is hand-rolled rather than depending on `js-yaml`. It is scoped to the exact field shapes the workspace uses (flat scalars, flat lists, lists of mappings, inline lists) and has a 12-scenario unit test covering byte-identity preservation on no-op updates, ISO timestamp round-trips, nested `chatSessions` arrays, and quoting edge cases.

### Mandatory teardown order

Nested project worktrees introduced a subtle git hazard: if you remove the workspace worktree first, git silently deletes the nested project worktree directories (including their `.git` files) and leaves orphan worktree records in the project repos marked `prunable`. The operation appears successful but the project repos are left in an inconsistent state. This was verified empirically against a throwaway session before the refactor was designed.

The cleanup script (`cleanup-work-session.mjs`) now enforces the safe order: for each repo listed in the session tracker, remove the nested project worktree first using `git -C repos/{repo} worktree remove ...`, then remove the workspace worktree, then `git worktree prune` each project repo as a belt-and-suspenders safety net for orphans from any prior misuses, and finally `rm -rf` the entire session folder. `/complete-work` documents the order explicitly in its Step 11.

### What changed where

The refactor touched most of the template:

- **New library** — `.claude/lib/session-frontmatter.mjs` plus a unit test file. 77 assertions pass against the parser.
- **Scripts rewritten** — `create-work-session.mjs` drops the symlink and the Windows junction branch entirely, creating `work-sessions/{name}/workspace/` with a real `repos/` directory inside. `cleanup-work-session.mjs` enforces the mandatory teardown order. `add-repo-to-session.mjs` creates the new nested worktree and updates the tracker frontmatter via the new helper. All three now route through a `normalizeRepos` helper that defensively handles a `repos:` field that might be a scalar string from a hand-edited tracker.
- **Hooks updated** — `_utils.mjs` replaces the old JSON marker helpers with session.md helpers. `session-start.mjs` registers the current chat in the tracker's `chatSessions` frontmatter list; `session-end.mjs` sets the `ended` timestamp and appends a safety-net note to the body. `repo-write-detection.mjs` recognizes writes inside `work-sessions/{name}/workspace/repos/{repo}/` and the renamed `workspace-scratchpad/`. `pre-compact.mjs` points at the new tracker path. `worktree-create.mjs` walks project repos via `git worktree list` rather than pattern-matching filesystem paths, so it keeps working regardless of where worktrees live.
- **Skills updated** — `start-work` and `complete-work` and `pause-work` and `sync-work` and `workspace-init` and `maintenance` and `workspace-update` all reference the new layout. `complete-work` additionally gained per-repo remote-type detection (GitHub / local-or-bare / other / no-remote) with separate push and merge flows for each, so sessions with non-GitHub remotes can now complete without manual intervention. `handoff`, `braindump`, and `aside` updated to stop writing to the deleted `shared-context/{user}/inflight/` directory.
- **Rules rewritten** — `workspace-structure.md` has a new directory layout table and a spec/plan location override pointing at `work-sessions/{name}/`. `git-conventions.md` describes the new nested worktree layout. `memory-guidance.md` points at the session tracker body as the in-session capture target.
- **Config and scaffolder** — `_gitignore` has the new patterns (including a carefully-worded block explaining why the `work-sessions/**` + negation pattern is necessary — see below). `workspace.json.tmpl` adds `workSessionsDir: work-sessions` and changes `scratchpadDir` from `.claude-scratchpad` to `workspace-scratchpad`. `CLAUDE.md.tmpl` references the new paths. `lib/init.mjs` and `lib/scaffold.mjs` drop pre-creation of `repos/`, `work-sessions/`, and `workspace-scratchpad/` — all three are lazy-created when scripts and hooks first write to them. All `.keep` files in the template are deleted.
- **Docs rewritten** — chapters 01, 02, 03, 04, 05, 06, 07, 09, 10, 11 and both user-facing guides. Chapter 10 gained a new section documenting the manual v0.8.0 upgrade procedure for existing workspaces.

### The `.claude-scratchpad` → `workspace-scratchpad` rename

The hidden-dot prefix was reflexive, modeled on `.claude/` without any functional reason to be hidden. The new name is visible in a normal `ls` and tells users it's workspace-scoped. `workspace.json`'s `scratchpadDir` field configures the location, so any hook or script that resolves it through `getWorkspacePaths()` picks up the new default automatically.

### Smoke-test findings folded in before merge

After the initial implementation, a throwaway v0.8.0 workspace was initialized and exercised end-to-end to validate the new layout against a real (if tiny) workspace rather than just the unit tests. Two issues surfaced and were fixed in the same session:

**The gitignore negations were silently dead.** The first draft used `work-sessions/` (directory ignore) plus `!work-sessions/*/session.md` negations. Git cannot re-include files beneath an ignored parent directory — the negations had no effect, and session trackers, specs, and plans were not actually tracked despite appearing so in documentation. This was verified with `git check-ignore -v`, which reported the files ignored by the directory rule. The fix uses `work-sessions/**` to ignore every descendant at every depth, then re-includes session folders as walkable directories via `!work-sessions/*/`, and finally re-includes the specific filename patterns. Nested contents like `work-sessions/{name}/workspace/...` stay ignored because they are matched by `**` and never re-included. Pattern-level tests verified that all three tracked file types are picked up by git, worktree contents stay invisible, and stray files directly inside `work-sessions/` are also ignored.

**`/complete-work` assumed GitHub remotes.** The skill hard-coded `gh pr create` and `gh pr merge` with no fallback for local or bare remotes, which made the throwaway smoke test (using a local bare mirror as origin) impossible to complete without manual intervention. The skill now detects the remote type per repo in Step 7 and branches Steps 8 and 9 into a GitHub PR flow (unchanged) and a local merge flow that pushes the feature branch to the bare remote, fast-forwards the default branch via `git push origin HEAD:{default-branch}`, deletes the feature branch from the remote, and pulls the source clone. The unified summary in Step 9 adapts its wording — "Merge all locally?" instead of "PR #n" — for repos without a PR concept.

### Verification

- Parser library unit tests: 77 assertions, all passing, covering the 12 supported scenarios including lossless byte-identity on no-op updates.
- End-to-end smoke test on a throwaway workspace at `/tmp/ws-refactor-smoke/fake-workspace/` and then `/Users/myrondavis/claude-workspaces/throwaway/`: `create-work-session` → `add-repo-to-session` → `cleanup-work-session` all pass. Both single-repo and multi-repo flows exercised. Nested project worktrees torn down cleanly in the mandatory safe order. The `session-start.mjs` → `session-end.mjs` helper flow (register chat, mark ended) verified against a test tracker.
- Independent code review by a subagent against the spec surfaced 11 issues (1 critical path, 4 moderate, 6 minor). All blocking and moderate items were fixed in commit `51679ef`. The 2 throwaway-smoke-test findings were fixed in `0976ba8`.

### Breaking vs not

This is **breaking on disk** but **not breaking in the user-facing skill API**. Users still call `/start-work`, `/complete-work`, `/pause-work` the same way. What changes is the shape of the directories and files those skills create, read, and remove. Existing workspaces upgrade manually via the procedure documented in chapter 10 of the docs: drain in-flight work, pull the new template, run `/workspace-update`, delete the old `.claude-scratchpad/` and `shared-context/{user}/inflight/` directories, smoke-test with a new `/start-work`, then move on. There is no migration skill and no auto-detection by design — the migration is a one-time event per workspace and clean state is a prerequisite.

The target version for this refactor is v0.8.0. The version field in `package.json` is bumped to 0.8.0 as part of this completion.
