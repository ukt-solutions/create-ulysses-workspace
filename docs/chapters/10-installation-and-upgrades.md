# Installation and Upgrades

A workspace starts with a scaffold command and evolves with template upgrades. The CLI creates the initial structure — directories, configuration files, rules, skills, hooks. When a new template version ships, the upgrade mechanism stages the changes and a skill applies them interactively. This chapter covers both paths.

---

## Scaffolding a New Workspace

To create a new workspace:

```bash
npx @ulysses-ai/create-workspace --init my-workspace
```

The CLI installs the bootstrap essentials: CLAUDE.md (generated from template), workspace.json, the workspace-init and workspace-update skills, all hooks, all scripts, the shared library helpers, shared-context directory structure, and gitignore. The remaining skills, rules, and agents are installed interactively by `/workspace-init`. The `repos/`, `work-sessions/`, and `workspace-scratchpad/` directories are lazy-created when they first need to hold something.

One detail of the template's layout is invisible in the installed workspace: the package stores `_gitignore`, `_claude/`, and `_mcp.json` under these inert names because Claude Code treats `.claude/` directories and `.mcp.json` files as protected paths that headless workers cannot edit — the live names inside `template/` would block automated maintenance of the template itself. Both `--init` and `--upgrade` write the live names out: the scaffold installs `.gitignore`, `.claude/`, and `.mcp.json` directly, and the staged `.workspace-update/` payload also carries `.claude/` and `.mcp.json` under their live names, keeping the layout that older workspaces' already-installed skills expect.

If you omit the directory name, the current directory is used — this supports initializing an existing project directory as a workspace:

```bash
cd my-existing-project
npx @ulysses-ai/create-workspace --init
```

If a CLAUDE.md already exists, it is backed up to `CLAUDE.md.bak` and replaced with the workspace version. The old content is preserved for `/workspace-init` to extract useful preferences and conventions from.

After scaffolding, the workspace has the bootstrap structure:

```
my-workspace/
├── CLAUDE.md                  (generated from template)
├── workspace.json             (with workspace name and empty repos)
├── shared-context/
│   └── locked/                (empty)
├── .workspace-update/         (staged template payload)
└── .claude/
    ├── skills/
    │   ├── workspace-init/    (bootstrap skill)
    │   └── workspace-update/  (bootstrap skill)
    ├── hooks/                 (all hooks installed)
    ├── scripts/               (all scripts installed)
    └── lib/                   (shared parser helpers)
```

The full template (remaining skills, rules, agents) lives in `.workspace-update/` and is installed interactively by `/workspace-init`. `repos/` is created when the first repo is cloned, `work-sessions/` when the first session is started, and `workspace-scratchpad/` when the first hook or script needs to write to it.

## First-Time Initialization

After scaffolding, open the workspace in Claude Code and run `/workspace-init`:

```bash
cd my-workspace
claude
/workspace-init
```

The skill creates a `chore/workspace-init` branch and walks you through a comprehensive setup:

1. **Inventory.** Scans for existing files, pre-migration content, and auto-memory.
2. **Clone repos.** Reads workspace.json and clones each configured repo into `repos/`.
3. **Identify documentation sources.** Asks where project documentation lives (Notion, Confluence, markdown, etc.) — checks for already-extracted content before re-fetching.
4. **Install template components.** Installs remaining skills, rules, and agents from the staged payload. Asks before overwriting any existing files.
5. **Activate optional rules.** Presents `.skip` rules and lets you choose which to activate.
6. **Extract documentation.** Pulls team knowledge from identified sources into rules and shared context.
7. **Scan Claude chat history.** Searches `~/.claude/projects/` for prior conversation logs, synthesizes decisions and context into shared context. Uses a manifest to survive auto-compaction during processing.
8. **Preserve local preferences.** Extracts conventions and settings from CLAUDE.md.bak.
9. **Create locked team knowledge.** Combines extracted content into `shared-context/locked/`.
10. **Formalize existing worktrees.** Detects in-progress git worktrees and creates `work-sessions/{name}/` folders with session trackers for them, linking to related chat history.
11. **Configure user identity.** Sets your name for user-scoped context.
12. **Clean and verify.** Moves non-template items to unmigrated, cleans up the payload, checks for self-contradictions.
13. **Set up workspace remote.** Creates a new repo or connects to an existing one (for team members joining a workspace that already exists).
14. **Merge to the default branch.** Squash-merges `chore/workspace-init` into the default branch (pushing if a remote is configured), so initialization ends with every commit — including `initialized: true` — on the default branch. The init branch itself is kept for its granular history.

For solo use, many steps are quick or skipped. For teams, the team lead runs the full init and commits the result. Team members then clone the workspace repo and run `/workspace-init` to connect — the skill detects the initialized workspace and handles onboarding (clone repos, set identity, rebase local changes onto the remote).

## Adding Repos

The repo manifest in workspace.json is the source of truth for which repos belong to the workspace:

```json
{
  "repos": {
    "my-app": {
      "remote": "git@github.com:team/my-app.git",
      "branch": "main"
    },
    "my-api": {
      "remote": "git@github.com:team/my-api.git",
      "branch": "develop"
    }
  }
}
```

Each entry specifies:
- **Key:** the directory name in `repos/` where the repo will be cloned
- **remote:** the git remote URL
- **branch:** the default branch that worktrees branch from and PRs target

The `branch` field is important — it tells skills which branch to fetch, rebase against, and create PRs targeting. If your repo uses `develop` as the integration branch, set it here.

After adding a repo to workspace.json, clone it:

```bash
git clone git@github.com:team/my-api.git repos/my-api
```

Or re-run `/workspace-init`, which will detect uncloned repos and offer to clone them.

## Template Versioning

workspace.json tracks which template version the workspace was created from:

```json
{
  "workspace": {
    "templateVersion": "0.4.0"
  }
}
```

This field is set during scaffolding and updated during upgrades. It lets the system know what version of the rules, skills, hooks, and scripts the workspace currently has.

Template versions follow semantic versioning. Patches are backward-compatible fixes. Minor versions add new features (new skills, new hooks, new workspace.json fields). Major versions have breaking changes to conventions or schema.

## Upgrading

When a new template version is available, upgrade with the CLI:

```bash
npx @ulysses-ai/create-workspace --upgrade
```

The upgrade does not apply changes directly. Instead, it stages a payload:

1. The CLI verifies the workspace is initialized and reads its current template version.
2. It writes the full new template to `.workspace-update/` with a manifest recording `action`, `fromVersion`, and `templateVersion`.

The `.workspace-update/` directory is a staging area, gitignored since v0.19.0. No files have been modified yet. The actual application happens interactively through the `/workspace-update` skill. If the CLI finds `.workspace-update/` already tracked by git — a leftover from upgrading an older workspace — it warns and tells you to untrack it (`git rm -r --cached .workspace-update`) before continuing.

## Applying Updates

After the CLI stages an upgrade, the workspace-update-check hook detects the `.workspace-update/` directory on the next tool call and nudges Claude to run `/workspace-update`.

The `/workspace-update` skill applies the staged changes interactively:

1. **Decides where the update lands.** The launcher root stays on its default branch — with one exception. A workspace repo with no remote applies the update in place and makes the single sanctioned launcher commit on the default branch; a workspace with a remote applies the update in a task worktree (`chore/template-update-{version}`) and lands it through a PR, like any other change to the workspace repo.

2. **Classifies the payload.** `classify-update.mjs` compares every verbatim-installed payload file against both the workspace and the template baseline (`.claude/.template-baseline.json`, the hashes of what the template last shipped here) and prints the decision lists: `new` (no installed counterpart), `identical` (already current), `updated` (still holds the baseline content while the template changed it — batched with `new`), `differs` (a local edit on a file the template also changed — asked per file), `localOnly` (a local edit on a file the template didn't change — informational, never asked), `deletedLocally` (in the template and its baseline but deleted from the workspace — one restore offer), `activated` (the template ships the rule as optional but this workspace keeps it active — nothing to install), `removed` (files the template no longer ships, minus what the workspace owns), and `staleTests` (dev-checkout test files the package never ships). Comparisons normalize line endings, so a Windows autocrlf checkout doesn't read as locally modified.

3. **Applies with confirmation.** New and template-updated files are batched behind a single confirmation; only locally modified files are asked about one by one, with a diff on request. Settings, `.gitignore`, and `CLAUDE.md` are merged, never overwritten. New `workspace.json` keys are shown with their template defaults before being added — existing keys and deliberately activated rules are never removed or renamed.

4. **Updates templateVersion and runs migrators.** Sets `workspace.json`'s `templateVersion` to the new version, then runs the two idempotent migrators that execute on every update (always with `--root .` — migrators resolve the workspace from `--root` or the cwd, never from their own location inside the payload). One-shot migrators run only when the workspace's previous version predates the layout step they migrate.

5. **Verifies.** The context catalogs are rebuilt (`build-workspace-context.mjs --write`) and `--check` must pass clean, then the scripted maintenance audit runs once with the list of files this update touched — findings on those files are labeled `(from this update)` so new drift is distinguishable from pre-existing state.

The two-stage approach (CLI stages, skill applies) means upgrades are never automatic or silent. You see every change before it takes effect.

The baseline is what keeps repeat upgrades quiet: written at scaffold time and rewritten at the end of every update, it records the hash of every verbatim-installed file the template last shipped. Entries hold the payload's hash — even for a file you kept in your own version, which then reads as a purely local edit (listed for information) until the template changes it again — while an update you declined keeps the older entry so the change is offered again next time, and a file nobody touched is never mistaken for a local edit. Workspaces upgraded from versions before v0.21 have no baseline on their first update; that one update asks about each changed file and writes the baseline for the next.

## Upgrading to v0.10.0 (in-worktree session layout)

v0.10.0 moves session content — the tracker, specs, and plans — inside the workspace worktree. The files now live at the top of each session branch as `session.md`, `design-*.md`, and `plan-*.md`, alongside `CLAUDE.md`. They travel with the branch via `git push` and get removed by `/complete-work` before the final PR so main stays free of session artifacts. The `work-sessions/` folder itself is fully gitignored at the workspace root in v0.10.0 — no more exception pattern for tracked session files.

The upgrade is automated end-to-end via `/workspace-update`. The migrator `migrate-session-layout.mjs` ships in the v0.10.0 payload; `/workspace-update` invokes it when the workspace's previous version predates v0.10.0.

### What the migrator does

For each active session's workspace worktree, the migrator:
1. Copies the launcher-side `session.md` into the worktree as a top-level `session.md`, and does the same for any `design-*.md` and `plan-*.md` files.
2. `git rm`'s every cross-session tracker ghost that the session branch inherited from main (v0.8.0 branches commonly carried other sessions' `work-sessions/*/session.md` paths in their tree).
3. Commits `chore: migrate session content into worktree` on the session branch.

For the launcher on main, the migrator collapses the `.gitignore` "Work sessions" block to a single `work-sessions/` line, runs `git rm --cached` on every launcher-tracked `work-sessions/*/session.md|design-*|plan-*`, bumps `workspace.json`'s `templateVersion` to `0.10.0`, and commits on main.

The migrator is idempotent — running it again on an already-migrated session or workspace is a no-op.

### Manual invocation

If you want to run the migrator directly instead of through `/workspace-update`:

```bash
# Migrate every active session at once:
node .claude/scripts/migrate-session-layout.mjs --all

# Migrate the launcher side (gitignore, rm --cached, version bump):
node .claude/scripts/migrate-session-layout.mjs --main
```

Running both in order gets you to v0.10.0 layout. The order matters — session branches are migrated first (so their content moves to the top of each worktree and ghost paths are removed), then the launcher commit cleans up main.

After the upgrade, each active session branch needs a one-time `git rebase main` to pick up the new tooling. The rebase should be conflict-free in principle because both sides deleted the same tracker paths.

## Upgrading to v0.8.0 (one-time manual procedure)

v0.8.0 restructures the on-disk layout so each work session lives in a single self-contained folder at `work-sessions/{name}/`. This replaces the scattered old layout where session state was spread across `repos/{name}___wt-*/`, `.claude-scratchpad/.work-session-*.json`, and `shared-context/{user}/inflight/`. It also eliminates the `repos/` symlink that caused the v0.5.1 destructive gitignore bug.

The user-facing skill API does not change — `/start-work`, `/complete-work`, `/pause-work` still work the same. The breaking part is the on-disk shape, which existing workspaces upgrade manually. There is no auto-migration. Clean state is required before upgrading.

### Procedure

1. **Drain in-flight work**
   - For each active or paused session: `/complete-work` if shippable, otherwise `/pause-work` and merge or close out the PR manually
   - Verify `ls repos/ | grep ___wt-` returns empty
   - Verify `ls .claude-scratchpad/.work-session-*.json` returns empty
   - Verify `ls shared-context/{user}/inflight/` returns empty
   - Commit any pending workspace changes to main

2. **Pull the new template**
   - `git pull` in the workspace repo to pick up the new template version
   - Run `/workspace-update` to apply the new template files

3. **Manual cleanup of old layout**
   - `rm -rf .claude-scratchpad/` — replaced by `workspace-scratchpad/`, which lazy-creates on first use
   - `rmdir shared-context/{user}/inflight/` — content was already drained in step 1
   - Commit the deletions

4. **Smoke test**
   - `/start-work blank` → name it `test-upgrade` → confirm it creates `work-sessions/test-upgrade/` with the expected internal layout
   - `cd work-sessions/test-upgrade/workspace/`, make a trivial change, verify `git status` is clean
   - Tear it down via `/complete-work` and verify the folder vanishes cleanly

5. **Multi-machine workspaces**
   - Pull on the second machine. The tracked `session.md`, `design-*.md`, and `plan-*.md` files come along automatically. Worktrees are local-only — they get recreated on first `/start-work` resume.

### What can go wrong

- **`/workspace-update` fails partway with merge conflicts in `.claude/`**: resolve manually and finish the update. Conflicts almost always come from template files you had customized.
- **Stale worktree records in a project repo (orphans from prior misuses)**: `git -C repos/{repo} worktree prune`.
- **Forgotten in-flight session discovered after the upgrade**: the old marker is gone but the worktree might still exist on disk. `git worktree list` from the project repo will show it. Either `git worktree remove` it manually or recreate the layout under the new convention by hand and resume from there.
- **Old inflight content in git history**: `git show {old-commit}:shared-context/{user}/inflight/{file}` to pull the content out, then drop it into the appropriate `work-sessions/{name}/session.md` or shared-context location.

## Staying Current

The workspace-update-check hook runs on every tool call. If a `.workspace-update/` directory exists, it injects a reminder into Claude's context. This means you will not forget about a pending update — Claude will mention it until you apply or dismiss it.

For teams, one person typically runs the upgrade and commits the result. The updated files — rules, skills, hooks, scripts — are tracked in git, so the rest of the team gets them on their next pull.

Custom rules, custom skills, and custom agents are not affected by upgrades. The template only manages its own files. Your additions are yours.

---

## Key Takeaways

- `npx @ulysses-ai/create-workspace --init` scaffolds a workspace with bootstrap skills, hooks, and scripts. The full template is staged for interactive installation.
- `/workspace-init` handles first-time configuration — cloning repos, installing template components, extracting team knowledge, activating rules, formalizing worktrees, setting user identity.
- Template versioning tracks which version of the template the workspace has.
- `--upgrade` stages changes; `/workspace-update` applies them interactively and verifies with a scripted post-update audit.
- Custom files are not affected by upgrades — the template manages only its own files.
