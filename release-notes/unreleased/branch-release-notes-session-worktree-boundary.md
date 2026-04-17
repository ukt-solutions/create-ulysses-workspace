---
branch: chore/session-worktree-boundary
type: feature
author: myron
date: 2026-04-16
---

## In-worktree session content

Session content — the tracker, specs, and plans — now lives **inside** each session's workspace worktree instead of one level above it. From inside the worktree, the files sit at the top of the branch as plain `session.md`, `design-*.md`, and `plan-*.md` alongside `CLAUDE.md` and `workspace.json`. They are tracked on the session branch, travel via `git push`, and get removed by `/complete-work` before the final PR so main's top level stays free of session artifacts.

### The bug this fixes

In v0.8.0, `session.md` lived at `work-sessions/{name}/session.md` — one level above the workspace worktree at `work-sessions/{name}/workspace/`. Git treats the worktree root as a repository boundary. From inside the worktree, `../session.md` resolves outside that boundary:

```
$ git add ../session.md
fatal: '../session.md' is outside repository at
  '/…/work-sessions/{name}/workspace'
```

The `.gitignore` tracked the file via an exception pattern (`!work-sessions/*/session.md`) evaluated from the workspace root, which always sits on main. So the only place `session.md` could be committed cleanly was the **workspace root on main** — never the session branch in the worktree. Writes from inside the worktree either silently failed or landed as stray commits on the launcher's local main, never reaching the session branch. `/complete-work` pushed a branch with no tracker content, PRs landed without context, and recovery cost four manual steps (cherry-pick, rebase, push, reset local main after merge).

A second, quieter bug compounded it: the `.gitignore` exception pattern tracked `work-sessions/*/session.md` for **every session** at once. New session branches cut from main inherited every other active session's tracker in their tree — cross-contamination that made merges destructive by default. A naive merge of a session branch could delete other sessions' work or re-add files that had been explicitly removed from main.

### What changes

Session content moves inside the worktree. `.gitignore` collapses the exception block to a single `work-sessions/` line — the whole tree is local-only at the workspace root. Tracking happens on each session's branch, where it belongs. A new `migrate-session-layout.mjs` script handles the one-time move for existing workspaces:

```bash
node .claude/scripts/migrate-session-layout.mjs --all      # migrate every active session
node .claude/scripts/migrate-session-layout.mjs --main     # collapse .gitignore, clean main, bump version
```

The migrator copies launcher-side tracker/spec/plan files into each worktree at the top of the session branch, `git rm`'s cross-contamination ghosts from each branch's tree, collapses the `.gitignore` exception block line-based (not regex — the commented version mentions `work-sessions/**` inline and trips naive non-greedy patterns), runs `git rm --cached` on every launcher-tracked session-content path, and bumps `workspace.json`'s `templateVersion`. It is idempotent: re-running on an already-migrated session or workspace is a no-op.

`/workspace-update` invokes the migrator between its pre- and post-update maintenance passes, so upgrading existing workspaces needs no manual steps beyond running the CLI.

### Skill and helper changes

`create-work-session.mjs` now writes the initial tracker inside the new worktree and commits it on the session branch as the branch's first commit — not via the launcher. `session-end.mjs`'s safety-net auto-commit runs from inside the worktree (previously from the launcher, which fails post-migration because `work-sessions/` is fully gitignored there). `add-repo-to-session.mjs` promotes its root via `getMainRoot` so session paths resolve correctly whether the script is invoked from the launcher or from inside a worktree.

`_utils.mjs` gains `sessionWorktreePath(root, name)` for callers that need the worktree root, and `sessionFilePath` / `getSessionTrackers` repoint to the in-worktree path. The frontmatter parser is unchanged.

`/complete-work` picks up a new step (6c): before the final rebase onto main, it `git rm`'s `session.md`, `design-*.md`, and `plan-*.md` from the branch top and commits the removal so the PR diff against main contains only the real implementation changes.

The workspace-structure rule is rewritten end-to-end, removing the "gitignored-folder-with-tracked-file-exception" paragraph and the old "Spec and Plan Locations" override in favor of a new override that points at the top of the session worktree.

### Side effect: start-work user filter ported into the template

The fix for "start-work session list shows other users' sessions" (`fix: filter /start-work session list by current user`) had been committed directly against the dogfood workspace and was waiting for a template port. It comes along in this release because the dogfood-to-template sync picked it up while the session-boundary fix was being applied. The behavior addition matches what was already live in the dogfood workspace — no new design.

### Tests

`template/.claude/hooks/_utils.test.mjs` adds five assertions covering the repointed path helpers and the new `sessionWorktreePath`. `template/.claude/scripts/migrate-session-layout.test.mjs` adds fifteen assertions covering per-session migration, idempotency, cross-contamination cleanup, and the main-side `.gitignore` collapse + `rm --cached` + version bump. Both run as plain `node path/to/file.test.mjs` — no dependencies.

### Breaking changes

- **On-disk layout.** Existing workspaces on v0.8.0 need to run the migrator (or `/workspace-update`) once. Skill flows are unchanged.
- **`.gitignore` shape.** The `work-sessions/**` + three `!` exceptions collapse to `work-sessions/`. Projects that had custom additions to that block need to reapply them after migration.
- **`templateVersion` jumps from 0.9.0 to 0.10.0.** The 0.9.x line is skipped intentionally to avoid confusion with workspaces that already applied the Playwright MCP change at 0.9.0.

### What does not change

- The session tracker frontmatter format (still parsed by `session-frontmatter.mjs`, all 77 existing assertions green).
- The workspace worktree / project worktree nesting.
- `cleanup-work-session.mjs` behavior (worktree removal still cascades through session content automatically).
- `/start-work`, `/complete-work`, `/pause-work` user-facing flow.

### Acceptance

From inside any session worktree post-migration:

```bash
$ git add session.md        # succeeds — lands on session branch
$ git ls-files 'work-sessions/*'
                             # empty — no cross-contamination from other sessions
```

On main post-migration:

```bash
$ git ls-files 'work-sessions/*/session.md' 'work-sessions/*/design-*.md' 'work-sessions/*/plan-*.md'
                             # empty — nothing session-scoped tracked at launcher level
```

The dogfood workspace reproduced the original bug (`fatal: outside repository`) on 2026-04-16 before the fix was implemented, ran all three of its active sessions through the migrator, and exited with main pristine.
