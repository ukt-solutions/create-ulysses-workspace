---
state: ephemeral
lifecycle: active
type: spec
topic: worksessions-refactor
branch: feature/worksessions-refactor
author: myron
updated: 2026-04-13
---

# Design: Work-Sessions Folder Refactor

Restructure the on-disk layout of a workspace so each work session is a single self-contained folder under a new `work-sessions/` top-level directory. Eliminate the symlink hack that caused the destructive gitignore bug, eliminate the scattered three-location session state, and align the disk model with the "one folder = one session" mental model the future desktop app will need.

This is an internal layout refactor. The user-facing skill API does not change — `/start-work`, `/complete-work`, `/pause-work` are still called the same way. What changes is the shape of the directories and files those skills create, read, and remove.

Targets v0.8.0. Breaking on disk, not breaking in API.

## Why

The current layout has accumulated cognitive debt:

- **The `repos/` symlink is a foot-gun.** Every workspace worktree contains a `repos -> ../..` symlink so that paths inside the worktree resolve to the workspace's `repos/` dir. The `.gitignore` pattern `repos/` (with trailing slash) only matched directories, not symlinks. `git add -A` inside a worktree staged the symlink. Pulling the resulting commit at the workspace root replaced the real `repos/` directory with the symlink. This bug shipped to dogfood and codeapy and was patched in v0.5.2 with a three-layer defense (gitignore fix, workspace-update migration, create-work-session safety check). The defense works but the underlying foot-gun remains.
- **Session state is scattered across three locations.** A single session has files in `repos/` (worktrees), `.claude-scratchpad/` (JSON marker), and `shared-context/{user}/inflight/` (markdown tracker). Specs and plans float separately in the project worktree root. Five locations in total. There is no clean unit of "this is one session, here is everything for it."
- **The `{session}___wt-{type}` worktree naming convention exists primarily because everything is in a flat `repos/` directory.** Once the layout nests sessions inside their own folder, the prefix becomes redundant noise.
- **The `.claude-scratchpad/` directory is hidden because of reflexive modeling on `.claude/`.** Nothing about its contents requires hiding. The dot-prefix made the directory invisible in `ls` for no functional gain.
- **Specs and plans live in the project worktree but are not project artifacts.** They are session artifacts — consumed by `/complete-work` into release notes and never belonged in the project repo's working tree.
- **Multi-machine workflows lose session state at the machine boundary.** The inflight tracker is git-tracked, but its location inside `shared-context/{user}/inflight/` is awkward, and the marker JSON and worktrees are not portable at all.

The refactor pays down all of these at once and aligns the disk model with what the future desktop app will need to render: one folder per session.

## Target on-disk layout

```
ulysses-workspace/                      ← workspace repo root
├── .claude/                            ← rules, skills, hooks, scripts (tracked)
├── .gitignore
├── CLAUDE.md
├── workspace.json
├── workspace-scratchpad/               ← renamed from .claude-scratchpad (gitignored, lazy)
├── repos/                              ← source clones (gitignored, lazy)
│   └── create-ulysses-workspace/       ← bare clone, stays on default branch
├── shared-context/                     ← team + user knowledge (tracked)
│   ├── locked/
│   ├── open-work.md
│   └── myron/                          ← no more inflight/ subdir
└── work-sessions/                      ← session containers (mostly gitignored, lazy)
    └── fix-auth/                       ← one folder per session
        ├── workspace/                  ← workspace worktree (gitignored)
        │   └── repos/                  ← REAL dir, not symlink (gitignored)
        │       └── create-ulysses-workspace/  ← project worktree (gitignored)
        ├── session.md                  ← TRACKED (frontmatter = state, body = progress)
        ├── design-fix-auth.md          ← TRACKED (spec)
        └── plan-fix-auth.md            ← TRACKED (plan)
```

Five things per session folder: one workspace worktree (containing nested project worktrees), one tracker, one spec, one plan. The worktrees and any local-only artifacts are gitignored. The tracker, spec, and plan are tracked, so a `git push` of the workspace branch carries the durable session thinking across machines naturally.

The `.gitignore` pattern that makes this work:

```gitignore
work-sessions/
!work-sessions/*/session.md
!work-sessions/*/design-*.md
!work-sessions/*/plan-*.md
```

Standard gitignored-folder-with-tracked-file-exception pattern. Worktrees stay local; durable files cross machines.

Source clones stay at `repos/{repo}/` at the workspace root. Clones are workspace-scoped (one per repo, used by all sessions); sessions are session-scoped. Mixing them under `work-sessions/` would obscure the lifecycle distinction. Two top-level concepts (`repos/` for clones, `work-sessions/` for sessions) is intentional — each communicates its lifecycle by location.

## Unified session tracker

`work-sessions/{name}/session.md` replaces both the old `.work-session-{name}.json` marker and the old `shared-context/{user}/inflight/session-{name}.md` tracker. Single file. Frontmatter holds machine state. Body holds human content.

```markdown
---
type: session-tracker
name: fix-auth
description: Fix the auth timeout on mobile
status: active                          # active | paused | completed
branch: bugfix/fix-auth
created: 2026-04-13T05:33:50.000Z
user: myron
repos:
  - create-ulysses-workspace
workItem: 3                             # optional, link to open-work.md row id
chatSessions:
  - id: aa3c952e-dbff-4055-8bcc-e5f217618d57
    names: [pickup-from-braindump]
    started: 2026-04-13T05:33:50.000Z
    ended: 2026-04-13T07:12:00.000Z
  - id: bb4d063e-ec00-4166-cc71-cd3d3d4628a1
    names: []
    started: 2026-04-13T08:00:00.000Z
    ended: null
author: myron
updated: 2026-04-13
---

# Work Session: fix-auth

Brief one-liner restating the goal.

## Pre-session context

Anything captured from prior conversation before /start-work was invoked.

## Progress

Decisions made, work completed, blockers hit. Updated as the session runs.
Consumed by /complete-work into release notes.
```

The frontmatter is the single source of truth for machine state. The body is for humans only — scripts never read it. When `/start-work` registers a chat, it rewrites the frontmatter. When `/pause-work` flips status, it rewrites the frontmatter. When the body is updated, the frontmatter is left alone.

### Frontmatter parser

The nested `chatSessions` array of objects defeats the existing flat-key regex parser used by hooks today. A real YAML reader is required.

The implementation will ship a small purpose-built parser in `template/.claude/lib/session-frontmatter.mjs` rather than depending on `js-yaml`. Reasons:

- Lossless by construction. Round-trip rewrites preserve byte-identical output for unchanged fields. `js-yaml` round-trip can reorder keys and strip comments.
- Zero runtime dependency added to the template.
- Scope is narrow: ~10 known fields, two list types (`repos:` is a flat list, `chatSessions:` is a list of mappings). Hand-rolled parsing for this shape is a small, testable surface.

The helper exports `readSessionFrontmatter(path)` and `writeSessionFrontmatter(path, fields)`. The latter rewrites only the frontmatter block (between the leading `---` lines) and preserves the body unchanged.

A unit test asserts that read → write with no field changes produces a byte-identical file.

## Session lifecycle

The lifecycle of a session under the new layout. Each phase listed with what changes from today.

### Create — `/start-work` blank or via `create-work-session.mjs`

Today: create workspace worktree at `repos/{name}___wt-workspace/`, symlink `repos/` back to itself, create project worktrees as siblings at `repos/{name}___wt-{repo}/`, write JSON marker to `.claude-scratchpad/`, write tracker to `shared-context/{user}/inflight/`.

New, in order:

1. `mkdirSync('work-sessions/{name}', { recursive: true })`
2. `git -C {workspace-root} worktree add work-sessions/{name}/workspace {branch}`
3. `mkdirSync('work-sessions/{name}/workspace/repos')` — real directory, not symlink
4. For each project repo: `git -C repos/{repo} worktree add ../../work-sessions/{name}/workspace/repos/{repo} {branch}`
5. Copy `settings.local.json` into `work-sessions/{name}/workspace/.claude/` if it exists at workspace root
6. Write `work-sessions/{name}/session.md` with frontmatter populated and an empty body template
7. Tell the user to `cd work-sessions/{name}/workspace/`

The script becomes substantially smaller. No symlink branch. No Windows junction logic (the symlink was the only platform-conditional code). No scattered file writes across three locations.

### Resume — `/start-work` no parameter

Today: scan `.claude-scratchpad/` for `.work-session-*.json` files, present active sessions, recreate missing worktrees.

New: scan `work-sessions/*/session.md` for `status: active|paused`, present them, recreate missing worktrees from the branches recorded in the frontmatter.

### Pause — `/pause-work`

Rewrite session.md frontmatter `status: paused`, rewrite body progress section, push branch, draft PR. Same flow as today, single file touch instead of two.

### Complete — `/complete-work`

Today: rebase, synthesize release notes, create real PR, remove worktrees one at a time, leave dangling symlink, manually clean tracker.

New, in order:

1. Rebase project branches onto their default branches
2. Synthesize release notes from `work-sessions/{name}/design-*.md`, `plan-*.md`, `session.md` body, and the commit log
3. Create PRs for each project repo and the workspace repo
4. After merge: for each project repo, `git -C repos/{repo} worktree remove work-sessions/{name}/workspace/repos/{repo}`
5. Then `git -C {workspace-root} worktree remove work-sessions/{name}/workspace`
6. Belt-and-suspenders: for each project repo, `git -C repos/{repo} worktree prune` to mop up any orphans from prior misuses
7. Delete the entire `work-sessions/{name}/` folder — the tracker, specs, and plans are already archived in the release notes
8. Update `open-work.md` if a `workItem` was linked

**The teardown order in steps 4 and 5 is mandatory.** See "Verified mechanics" below.

### Sync — `/sync-work`

Identical to today. The new wrinkle: the workspace branch push now carries the tracked `session.md`/`design-*.md`/`plan-*.md` along for the ride. Multi-machine support comes for free — pull the workspace branch on a second machine, the session's durable thinking is already there, and the second machine recreates worktrees locally on first `/start-work` resume.

### Add a repo mid-session — `add-repo-to-session.mjs`

Today: adds a sibling worktree at `repos/{name}___wt-{newrepo}/`, updates JSON marker.

New: `git -C repos/{newrepo} worktree add ../../work-sessions/{name}/workspace/repos/{newrepo} {branch}`, append to `repos:` list in session.md frontmatter via the helper.

## Verified mechanics

The two non-obvious behaviors of nested worktrees were verified empirically before writing this spec.

### `git status` and `git worktree list` from the workspace worktree

A workspace worktree at `work-sessions/{name}/workspace/` containing a real `repos/` directory with nested project worktrees was tested. Findings:

- `git status` from inside the workspace worktree reports clean. The single line `repos` (no trailing slash) in the workspace `.gitignore` covers both `repos/` at the workspace root *and* the new `repos/` inside any worktree. Nested project worktree files do not appear as untracked. The same gitignore line works for both layouts — no separate per-worktree gitignore needed.
- `git worktree list` from inside the workspace worktree only lists worktrees of the workspace repo. It does not see nested project worktrees, which belong to a different git repo.
- `git -C repos/{repo} status` from inside the nested project worktree behaves normally and reports its own state.

### Teardown order

Two teardown orders were tested.

**Workspace-first (dangerous):** `git worktree remove work-sessions/{name}/workspace` while the project worktrees are still nested inside. Result: succeeds (`exit 0`), recursively deletes the directory tree including the nested project worktree's `.git` files, but **leaves an orphan worktree record in the project repo marked `prunable`**. Recovery requires `git -C repos/{repo} worktree prune`. This is a silent data hazard — the script appears to succeed but leaves the project repo's admin state stale.

**Project-first then workspace (safe):** for each project repo, `git -C repos/{repo} worktree remove work-sessions/{name}/workspace/repos/{repo}`, then `git -C {workspace-root} worktree remove work-sessions/{name}/workspace`. Result: both removes succeed clean, no orphans, both repos' worktree lists empty after.

**`/complete-work` and `cleanup-work-session.mjs` MUST use the safe order.** The session.md frontmatter's `repos:` list tells the script which project repos to walk. As a defensive measure, after teardown also run `git worktree prune` on each project repo to mop up orphans from any prior misuses (e.g., from sessions completed before this refactor shipped, or from manual cleanup attempts).

## File-by-file impact

Concrete list of what changes in the template, grouped by area.

### New files

| Path | Purpose |
|------|---------|
| `template/.claude/lib/session-frontmatter.mjs` | Lossless parser/writer for session.md frontmatter. Imported by hooks and scripts that read or update machine state. |
| `template/docs/chapters/12-upgrading-to-v0.8.md` (or fold into chapter 10) | Manual upgrade procedure for the layout change. |

### Scripts (rewrites)

| Path | Change |
|------|--------|
| `template/.claude/scripts/create-work-session.mjs` | New layout creation. Drops symlink logic and Windows junction branch entirely. Writes single `session.md` instead of separate JSON marker + tracker. |
| `template/.claude/scripts/cleanup-work-session.mjs` | New layout teardown. Enforces mandatory order: project worktrees first, then workspace worktree, then `git worktree prune` per project repo, then `rm -rf work-sessions/{name}/`. |
| `template/.claude/scripts/add-repo-to-session.mjs` | New worktree path. Updates `repos:` array in session.md frontmatter via the helper. |

### Hooks

| Path | Change |
|------|--------|
| `template/.claude/hooks/_utils.mjs` | `getSessionMarkers()` walks `work-sessions/*/session.md` instead of `.claude-scratchpad/.work-session-*.json`. Returns the parsed frontmatter via the new helper. Resolve scratchpad path from `workspace.json` (drop hardcoded `.claude-scratchpad`). |
| `template/.claude/hooks/session-start.mjs` | Register chat in session.md frontmatter via the helper. |
| `template/.claude/hooks/session-end.mjs` | Set `ended` timestamp in session.md frontmatter via the helper. |
| `template/.claude/hooks/repo-write-detection.mjs` | Path matching: detect writes inside `work-sessions/{name}/workspace/` and `work-sessions/{name}/workspace/repos/{repo}/`, not the old `___wt-` patterns. |
| `template/.claude/hooks/workspace-update-check.mjs`, `pre-compact.mjs`, `post-compact.mjs` | Verify; likely unchanged. |

### Skills

| Path | Change |
|------|--------|
| `template/.claude/skills/start-work/SKILL.md` | Complete rewrite of paths, flow, resume/blank logic. cd target becomes `work-sessions/{name}/workspace/`. |
| `template/.claude/skills/complete-work/SKILL.md` | Mandatory teardown order baked into the skill steps. New paths for spec/plan consumption. Whole-folder cleanup at the end. |
| `template/.claude/skills/pause-work/SKILL.md` | Single-file tracker update. New paths. |
| `template/.claude/skills/workspace-init/SKILL.md` | Drop creation of `.claude-scratchpad/`, `shared-context/{user}/inflight/`, and any pre-creation of `work-sessions/` or `repos/`. All four are lazy. |
| `template/.claude/skills/sync-work/SKILL.md` | Mostly unchanged. Doc updated to mention that tracked session.md/design/plan files now sync naturally. |
| `template/.claude/skills/maintenance/SKILL.md` | Health checks updated for new layout. Orphan worktree detection becomes more important since teardown order matters. |
| `template/.claude/skills/release/SKILL.md` | Verify; probably unchanged. |
| `template/.claude/skills/setup-tracker/SKILL.md` | Verify; probably unchanged. |
| `template/.claude/skills/build-docs-site/` | Verify content scanner does not trip on `work-sessions/` paths. |

### Rules

| Path | Change |
|------|--------|
| `template/.claude/rules/workspace-structure.md` | Full rewrite of directory layout table. Spec/plan location override updated: specs/plans live in `work-sessions/{name}/`, not the project worktree root. |
| `template/.claude/rules/git-conventions.md` | Worktree naming examples updated to drop `___wt-` prefix. |

### Config and docs

| Path | Change |
|------|--------|
| `template/_gitignore` | New patterns including the gitignored-folder-with-tracked-file-exception for `work-sessions/`. Drop `.claude-scratchpad`, add `workspace-scratchpad`. |
| `template/CLAUDE.md.tmpl` | Quick-reference paths updated. New "where to cd" line. |
| `template/workspace.json` (scaffolder default) | Default `scratchpadDir: "workspace-scratchpad"`. |
| `lib/init.mjs` (CLI scaffolder) | Drop pre-creation of `.claude-scratchpad/` and `shared-context/{user}/inflight/`. Drop `.keep` files everywhere. Lazy-create everything. |
| `docs/chapters/01-what-is-a-workspace.md` | Directory layout section rewritten. |
| `docs/chapters/02-work-sessions.md` | Major rewrite — this chapter is about the lifecycle and the lifecycle is what changed. |
| `docs/chapters/03-shared-context.md` | Remove inflight/ references. |
| `docs/chapters/10-installation-and-upgrades.md` (or new chapter 12) | Manual upgrade procedure for the layout change. |

### Things deleted entirely

- The symlink creation block in `create-work-session.mjs`
- The Windows junction branch in same file
- The `.claude-scratchpad/.work-session-*.json` JSON marker convention
- The `shared-context/{user}/inflight/` directory and its creation in `workspace-init`
- All `.keep` files in the template (`template/.claude-scratchpad/.keep`, etc.)
- The hidden `.claude-scratchpad/` directory name (replaced by `workspace-scratchpad/`)

## Manual upgrade procedure

This refactor is breaking on disk and not breaking in user-facing API. Existing workspaces upgrade manually. There is no `/migrate-to-work-sessions` skill, no auto-detection, no backup branch creation. The release notes for v0.8.0 and a docs chapter (chapter 10 or new chapter 12) carry the procedure below.

### Procedure

1. **Drain in-flight work in the old workspace**
   - For each active or paused session: `/complete-work` if shippable, otherwise `/pause-work` and merge or close out the PR manually
   - Verify `ls repos/ | grep ___wt-` returns empty
   - Verify `ls .claude-scratchpad/.work-session-*.json` returns empty
   - Verify `ls shared-context/{user}/inflight/` returns empty
   - Commit any pending workspace changes to main

2. **Pull the new template**
   - `git pull` in the workspace repo to pick up the new template version
   - Run `/workspace-update` to apply the new template files

3. **Manual cleanup of old layout**
   - `rm -rf .claude-scratchpad/` (replaced by `workspace-scratchpad/`, which lazy-creates on first use)
   - `rmdir shared-context/{user}/inflight/` (the directory itself goes away — content was already drained in step 1)
   - Commit the deletions

4. **Smoke test**
   - `/start-work blank` → name it `test-upgrade` → confirm it creates `work-sessions/test-upgrade/` with the expected internal layout
   - `cd work-sessions/test-upgrade/workspace/`, make a trivial change, verify `git status` is clean
   - Tear it down via `/complete-work` (or abandon and manually `git worktree remove` the project worktree first, then the workspace worktree) and verify the folder vanishes cleanly

5. **Workspaces with multiple machines**
   - Pull on the second machine. The tracked `session.md`/`design-*.md`/`plan-*.md` files come along automatically. Worktrees are local-only — recreate them on first `/start-work` resume.

### What can go wrong

| Failure | Recovery |
|---------|----------|
| `/workspace-update` fails partway with merge conflicts in `.claude/` | Resolve conflicts manually, finish the update. The conflict is almost always in template files the user has customized. |
| Stale worktree records in a project repo (orphans from prior misuses of the old layout) | `git -C repos/{repo} worktree prune` |
| Forgotten in-flight session discovered after the upgrade | The old marker is gone but the worktree might still exist on disk. `git worktree list` from the project repo will show it. Either `git worktree remove` it manually or recreate the layout under the new convention by hand and resume from there. |
| Old workspace branch with uncaptured `inflight/` content discovered post-upgrade | Pull the file out of git history (`git show {old-commit}:shared-context/{user}/inflight/{file}`), drop it into the appropriate `work-sessions/{name}/session.md` or shared-context location, recommit. |

### Version

v0.8.0. The user-facing API stays the same; the breaking-ness is internal to the layout. Per the project's versioning convention, v1.0 is reserved for the public-launch milestone, not for an internal layout refactor however invasive.

## Risks and known unknowns

### Implementation risks

| Risk | Mitigation |
|------|-----------|
| Frontmatter parser drift — round-trip rewrites alter formatting | Hand-rolled parser scoped to known fields. Lossless by construction. Unit test asserts read → write with no changes produces byte-identical output. |
| Hooks fire before the helper exists during workspace-update | The new helper file lands as part of the same template payload as the hooks. workspace-update writes all files atomically; hooks won't fire mid-update because Claude isn't running between disk writes. Verify by inspecting workspace-update's file write ordering. |
| `git worktree add` to a path whose parent doesn't exist | Script checks `existsSync` after `mkdirSync` and aborts with a clear error if the dir is missing. |
| Project worktree path resolution fragile under CWD changes | Use `path.resolve` to compute absolute paths. Pass absolute paths to `git worktree add`. Don't rely on relative path arithmetic. |
| `git worktree prune` deletes records for legitimately-relocated worktrees on other machines | Worktree records are local to each machine's clone. Pruning on B doesn't touch A. Verified — `git worktree prune` only operates on the local clone's `.git/worktrees/` admin dir. |

### Known unknowns to verify during implementation

| Unknown | When to verify |
|---------|----------------|
| Does `workspace-update-check.mjs` need any path updates? | Before merging — quick read |
| Do `pre-compact.mjs` / `post-compact.mjs` reference any session paths? | Before merging — quick read |
| Does `build-docs-site` skill's content scanner trip on `work-sessions/` paths? | After implementation, run the skill on a fresh workspace and check |
| Does `setup-tracker` skill reference any old paths? | Before merging — quick read |

### Out of scope (intentionally)

- Multi-user scenarios — single user assumption holds for the foreseeable future
- Cross-machine session ownership conflicts — single user
- A `/migrate-to-work-sessions` skill — manual upgrade is sufficient
- A backup/snapshot mechanism — clean state is required before upgrade
- Reworking shared-context/ structure — orthogonal; only `inflight/` going away is in scope here
- Rewriting hooks for unrelated reasons (performance, error handling, observability) — separate concerns
- Cleaning up old chore/ branches in the project repo — surfaced in the maintenance audit at session start, separate cleanup session
- Triaging `design-reference-skill.md` (untracked, likely superseded by the shipped `build-docs-site` skill) — separate decision

## Sizing

Roughly 4 to 6 hours of focused work, likely split across 2 sessions:

- **Session 1: implementation.** New library, three script rewrites, hook updates, skill updates, rule updates, gitignore + CLAUDE.md template + scaffolder updates. ~3–4 hours.
- **Session 2: docs and rollout.** Four docs chapters touched, manual upgrade procedure written into release notes, smoke test on a throwaway workspace, then dogfood and codeapy upgrades. ~1–2 hours.

The risk during session 1 is the frontmatter parser — get that wrong and every hook breaks. Build it first, test it in isolation, then wire the hooks to it.
