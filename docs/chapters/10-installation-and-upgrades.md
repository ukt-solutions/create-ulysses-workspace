# Installation and Upgrades

A workspace starts with a scaffold command and evolves with template upgrades. The CLI creates the initial structure — directories, configuration files, rules, skills, hooks. When a new template version ships, the upgrade mechanism stages the changes and a skill applies them interactively. This chapter covers both paths.

---

## Scaffolding a New Workspace

To create a new workspace:

```bash
npx @ulysses-ai/create-workspace@beta --init my-workspace
```

The CLI installs the bootstrap essentials: CLAUDE.md (generated from template), workspace.json, the workspace-init and workspace-update skills, all hooks, the script files, the shared library helpers, the `workspace-context/` directory, and the ignore files. The remaining skills, the rules, the agents, and the adapter modules under `scripts/` are installed interactively by `/workspace-init`. The `repos/`, `work-sessions/`, and `workspace-scratchpad/` directories are lazy-created when they first need to hold something.

`--init` writes files and does nothing else. It does not create a git repository, which is what lets it turn an existing project directory into a workspace. In a fresh directory, run `git init` yourself before `/workspace-init`: that skill does all of its work on a branch, so it needs a repository to branch in.

Until 1.0.0, install with `@beta`: `latest` is not maintained, and a bare `npx @ulysses-ai/create-workspace` may run an older beta.

One detail of the template's layout is invisible in the installed workspace: the package stores `_gitignore`, `_claude/`, and `_mcp.json` under these inert names because Claude Code treats `.claude/` directories and `.mcp.json` files as protected paths that headless workers cannot edit — the live names inside `template/` would block automated maintenance of the template itself. Both `--init` and `--upgrade` write the live names out where the installed skills expect them, and the staged `.workspace-update/` payload always carries `.claude/` and `.mcp.json` under their live names, keeping the layout that older workspaces' already-installed skills read.

If you omit the directory name, the current directory is used — this supports initializing an existing project directory as a workspace:

```bash
cd my-existing-project
npx @ulysses-ai/create-workspace@beta --init
```

If a CLAUDE.md already exists, it is backed up to `CLAUDE.md.bak` and replaced with the workspace version. The old content is preserved for `/workspace-init` to extract useful preferences and conventions from.

After scaffolding, the workspace has the bootstrap structure:

```
my-workspace/
├── CLAUDE.md                  (generated from template)
├── workspace.json             (with the workspace name and no repos)
├── .gitignore                 (created, or merged into an existing one)
├── .claudeignore
├── workspace-context/
│   └── shared/
│       └── locked/            (the canonical level, where team truths live)
├── .workspace-update/         (staged template payload)
└── .claude/
    ├── .template-baseline.json  (hashes of the installed template files)
    ├── skills/
    │   ├── workspace-init/      (bootstrap skill)
    │   └── workspace-update/    (bootstrap skill)
    ├── hooks/                   (all hooks installed)
    ├── scripts/                 (the script files)
    └── lib/                     (shared parser helpers)
```

The full template — the remaining skills, the rules, the agents, `settings.json`, and the `forges/` and `trackers/` adapters — lives in `.workspace-update/` and is installed interactively by `/workspace-init`. `repos/` is created when the first repo is cloned and `workspace-scratchpad/` when the first hook or script needs to write to it. `work-sessions/` is created only for a session started under the old session lifecycle: new work is a task and never touches it.

## First-Time Initialization

After scaffolding, open the workspace in Claude Code and run `/workspace-init`:

```bash
cd my-workspace
claude
/workspace-init
```

The skill creates a `chore/workspace-init` branch and walks you through a comprehensive setup:

1. **Inventory.** Scans for existing files, pre-migration content, and auto-memory.
2. **Clone repos.** Reads workspace.json and offers to clone each configured repo into `repos/`, then registers each clone as a `repo-{name}` remote on the workspace repo, so that a pull request in that project is matched to a chat at the workspace root ([Chapter 7](07-hooks-and-scripts.md#repo-remotesmjs)). With the file open, it notes the work lifecycle: new work is always a task, so there is nothing to choose.
3. **Identify documentation sources.** Asks where project documentation lives (Notion, Confluence, markdown, etc.) — checks for already-extracted content before re-fetching.
4. **Present the plan.** Lays out a numbered plan for the rest of the run, and shows it before executing any of it.
5. **Install template components.** Installs the remaining skills, rules, agents, scripts, and `settings.json` from the staged payload. Asks before overwriting any existing files, and offers to generate `CODEBASE.md` and a `CLAUDE.md` stub for each repo.
6. **Activate optional rules.** Presents `.skip` rules and lets you choose which to activate.
7. **Extract documentation.** Pulls team knowledge from identified sources into rules and workspace context.
8. **Scan Claude chat history.** Searches `~/.claude/projects/` for prior conversation logs, synthesizes decisions and context into workspace context. Uses a manifest to survive auto-compaction during processing.
9. **Preserve local preferences.** Extracts conventions and settings from CLAUDE.md.bak.
10. **Create locked team knowledge.** Combines extracted content into `workspace-context/shared/locked/`.
11. **Formalize existing worktrees.** Detects in-progress git worktrees and creates `work-sessions/{name}/` folders with session trackers for them, linking to related chat history.
12. **Set up the issue tracker and MCP servers.** Offers `/setup-tracker`, then gives guidance on configuring MCP servers in `.mcp.json`.
13. **Configure user identity and start the team roster.** Sets your name for your personal context, `workspace-context/team-member/{user}/`, and offers to record you as the roster's first entry.
14. **Clean the root.** Moves everything in the root that is not template structure to `workspace-scratchpad/unmigrated/`.
15. **Clean up the payload.** Deletes `.workspace-update/` and the other pre-migration artifacts.
16. **Verify.** Checks the result for self-contradictions.
17. **Set up the workspace remote.** Creates a new repo, or connects to one that already exists — the case of a workspace initialized locally and then pointed at the team's remote, which rebases the init branch onto it first.
18. **Mark initialized and merge.** Sets `initialized: true`, then offers to squash-merge `chore/workspace-init` into the default branch (pushing it if the workspace repo has an `origin`), so initialization ends with every commit on the default branch. The `repo-{name}` remotes that mirror the project clones do not count towards that: none of them is the workspace's own. The init branch itself is kept for its granular history.

For solo use, many steps are quick or skipped. For teams, the team lead runs the full init, which ends on the default branch. Team members then clone the workspace repo and run `/workspace-init` to connect: because `workspace.json` says the workspace is initialized, the skill runs its **join** flow instead. A join sets up only that one machine — the user identity, any missing repo clones, each registered as a `repo-{name}` remote of the workspace repo, the per-user context folder, and `CLAUDE.local.md`. Everything it writes is gitignored or local git config, so it creates no branch and makes no commits.

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

Either way the clone is registered as a `repo-{name}` remote on the workspace repo: the session-start hook does it at the next launch, or `node .claude/scripts/repo-remotes.mjs --root .` does it at once.

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

What a version number promises is defined in [VERSIONING.md](../../VERSIONING.md). In short: a patch leaves the documented contract as it is, a minor adds something or ships a migration, and a major changes the contract. Until 1.0.0 a breaking change rides on a minor bump instead of a major, so read the release notes rather than relying on the number.

## Upgrading

When a new template version is available, upgrade with the CLI:

```bash
npx @ulysses-ai/create-workspace@beta --upgrade
```

`@beta` matters: until 1.0.0 `latest` is not maintained and may point to an older beta, which is what a bare `npx @ulysses-ai/create-workspace` installs. When the session-start banner or a `/maintenance` audit finding names a version, install that one exactly — `npx @ulysses-ai/create-workspace@<version> --upgrade`.

The upgrade does not apply changes directly. Instead, it stages a payload:

1. The CLI verifies the workspace is initialized, reads its current template version, and refuses when the template it ships is older than that version — see [Refusing downgrades](#refusing-downgrades).
2. It writes the full new template to `.workspace-update/` with a manifest recording `action`, `fromVersion`, and `templateVersion`.
3. When the workspace has no usable template baseline (it predates v0.21, or the file is corrupt), the CLI reconstructs one for the installed version and stages it **inside the payload** as `.workspace-update/.template-baseline.reconstructed.json` — never in the launcher. It fetches that version's package tarball from the npm registry (registry fetch with a 15s abort timeout, `npm pack` fallback with a 30s timeout), hashes the template files that version shipped — handling both the old live-name layout (`.claude/`, `.mcp.json`) and the current inert one (`_claude/`, `_mcp.json`) — and marks the baseline `"reconstructed": true`. Staging it in the payload matters because a workspace with a remote applies updates inside a task worktree that can only see what travels with the payload, and an untracked launcher baseline would dirty the launcher against the incoming PR. The same fetched tarball also stages the installed version's template files at `.workspace-update/.template-base/` — the merge base `/workspace-update` merges locally edited files against (see [Applying Updates](#applying-updates)). If the tarball cannot be fetched (unknown version, no network) the CLI warns and continues without a baseline or merge base; the upgrade never fails because of this.
4. It installs the payload's `workspace-update` skill into `.claude/skills/workspace-update/`, replacing whatever older copy the workspace carries — the skill that processes the payload is always the current one, never a stale installed flow improvising around a format it predates. A locally customised `SKILL.md` (matching neither the payload's copy nor the hash of what the installed version shipped) is backed up as `SKILL.md.local-backup` first, and the new tree is staged and swapped in only after the copy succeeded, so a failure leaves the old skill intact.

The `.workspace-update/` directory is a staging area, gitignored since v0.19.0. No other files have been modified yet. The actual application happens interactively through the `/workspace-update` skill. If the CLI finds `.workspace-update/` already tracked by git — a leftover from upgrading an older workspace — it warns and tells you to untrack it (`git rm -r --cached .workspace-update`) before continuing.

### Refusing downgrades

`--upgrade` stages the template of the CLI version that runs it. When that template is older than the workspace's, staging it would hand `/workspace-update` a downgrade, so the CLI refuses instead: it names both versions and the command to run instead, exits non-zero, and writes nothing — no payload, so the workspace-update-check hook has nothing to pick up. This is the state a bare `npx @ulysses-ai/create-workspace` leaves you in while `latest` sits behind `beta`: the older CLI, run on a newer workspace.

```bash
npx @ulysses-ai/create-workspace@<version> --upgrade
```

`<version>` is the workspace's own template version or a newer one. Until the workspace is on a stable release, the dist-tag of its channel — `@beta`, or `@rc` for a release candidate — is the shortest way to name the newest one. A workspace whose `templateVersion` is missing or is not a version is never refused: there is nothing to compare. To stage an older template on purpose, pass `--allow-downgrade`:

```bash
npx @ulysses-ai/create-workspace@<version> --upgrade --allow-downgrade
```

## Applying Updates

After the CLI stages an upgrade, the workspace-update-check hook detects the `.workspace-update/` directory — at the start of the next chat, and on every tool call from then on — and tells Claude to run `/workspace-update` before doing anything else.

The `/workspace-update` skill applies the staged changes interactively:

1. **Decides where the update lands.** Whenever the workspace repo has an `origin` — even one you cannot push to — the update is applied in a task worktree (`chore/template-update-{version}`) and lands through a PR or MR, like any other change to the workspace repo. A commit made directly on the launcher's local default branch would diverge from `origin/<default>`: the push is refused on a protected default branch, and task worktrees based on `origin/<default>` could not fast-forward past it. The default branch is therefore never pushed directly. Only a workspace repo with no `origin` applies the update in place, making the single sanctioned launcher commit on its default branch. The `repo-{name}` remotes that mirror the project clones do not count towards this: they are never pushed to, so they say nothing about where an update can land. The task scripts (`task-worktree.mjs`, `task-pr.mjs`) run from the staged payload whenever the workspace's own copies are missing — pre-0.18 workspaces predate them, and the payload always carries them. After the PR/MR merges, the skill restores the launcher's replaced skill copy (so the PR lands on a clean launcher), pulls `--ff-only`, rebuilds the context catalogs (the pull can delete the gitignored per-user index that `CLAUDE.local.md` imports), and removes the update worktree together with its local branch. Newly added skills appear only after that merge — a new chat or `/reload` picks them up.

2. **Classifies the payload.** `classify-update.mjs` compares every verbatim-installed payload file against both the workspace and the template baseline (`.claude/.template-baseline.json`, the hashes of what the template last shipped here — in the worktree flow passed with `--baseline`, defaulting to the workspace's own baseline and falling back to the payload's `.template-baseline.reconstructed.json`; a corrupt baseline file counts as absent) and prints the decision lists: `new` (no installed counterpart), `identical` (already current), `updated` (still holds the baseline content while the template changed it — batched with `new`), `differs` (a local edit on a file the template also changed — asked per file), `config` (`.mcp.json` and `.claude/settings.json` — see below), `localOnly` (a local edit on a file the template didn't change — informational, never asked), `deletedLocally` (in the template and its baseline but deleted from the workspace — one restore offer), `activated` (the template ships the rule as optional but this workspace keeps it active — nothing to install), `removed` (files the template no longer ships, minus what the workspace owns), and `staleTests` (dev-checkout test files the package never ships). Entries in `differs`, `localOnly`, `deletedLocally`, and `removed` carry their registered reason from `.claude/template-modifications.json` (see below) when the path is in its `modifications` map. Comparisons normalize line endings, so a Windows autocrlf checkout doesn't read as locally modified. `removed` entries can carry markers: `referencedBy` names a hook that a workspace-only `settings.json` entry still registers, and `userOwned` flags a file with no baseline record — the template never shipped it, so it is the workspace's own. `implicitDefaults` reports `workspace.json` keys whose absence carried a default in the version being upgraded from: between v0.15 and v0.19 an absent `canonicalBudgetBytes` meant a 40 KB budget (earlier versions had no budget at all; since v0.19 absent means off). `staleModifications` lists registry entries whose installed file already matches the payload — the update offers to drop them — `legacyKeys` lists registry data still sitting in `workspace.json`, which the update offers to migrate, and `ignoredKeys` lists registry keys that escape `.claude/` — the registry covers `.claude/` paths only, so those keys cover nothing. A registry that doesn't parse fails the classification closed: `modificationsError` names the error, every `removed` entry is marked unverifiable, and the update stops and asks you to fix the JSON before any per-file decision.

3. **Applies with confirmation.** New and template-updated files are batched behind a single confirmation. Locally modified files are merged three-way against the staged base when one exists — clean merges batch behind one confirmation, conflicts are resolved one file at a time with the operator's approval (see below) — and asked about one by one, with a diff on request, otherwise; a registered file's reason is shown at each of those decisions, and keeping your version of a file offers to record one. The two JSON configs — `.mcp.json` and `.claude/settings.json` — are never copied wholesale (that would wipe a workspace's own MCP servers): each is reported with a key-level diff and merged key by key — template keys are added, workspace-only keys are kept, conflicting keys are asked about individually, and array-valued keys (hooks event lists, `permissions.allow`/`deny`) diff by element and merge as a union, so only true scalar conflicts ask. A config the workspace doesn't have yet is offered once, never installed silently. `.gitignore` and `CLAUDE.md` are merged too, never overwritten. New `workspace.json` keys are shown with their template defaults before being added — existing keys and deliberately activated rules are never removed or renamed, except the legacy `localFiles`/`templateModifications` keys, which migrate into `.claude/template-modifications.json` with your yes. A few cases get their own ask: a removed hook still registered in `settings.json` is removed as a pair (file plus settings entry, never one without the other); a removed file the template never shipped is offered a `localFiles` entry in `.claude/template-modifications.json` instead of deletion; a CLAUDE.md merge reporting an `@`-include whose file doesn't exist asks whether to create the stub or leave the include out; a merge dropping something the template has retired — an `@`-include it no longer ships (today `@workspace.json`, whose config summary the SessionStart hook now injects), or a bullet that is no longer true (today the Quick Reference line that placed all work in session worktrees) — names each drop in its output so it is visible in the diff you approve. A template line the payload no longer ships but that still holds, such as the bullet describing a session's folder, is kept as the workspace's; and an upgrade from v0.15–v0.19 writes `canonicalBudgetBytes: 40960` explicitly, keeping the workspace's previous trimming instead of silently turning it off.

4. **Updates templateVersion and runs migrators.** Sets `workspace.json`'s `templateVersion` to the new version, then runs the two idempotent migrators that execute on every update (always with `--root .` — migrators resolve the workspace from `--root` or the cwd, never from their own location inside the payload). One-shot migrators run only when the workspace's previous version predates the layout step they migrate.

5. **Verifies.** The context catalogs are rebuilt (`build-workspace-context.mjs --write`) and `--check` must pass clean, then the scripted maintenance audit runs once with the list of files this update touched — findings on those files are labeled `(from this update)` so new drift is distinguishable from pre-existing state.

6. **Points at what is left to drain.** When the sessions directory still holds sessions under the old session lifecycle — counted from the directory alone, with `migrate-sessions.mjs --legacy-sessions` — the report ends with a line pointing at `/migrate-sessions`. From this update on, new work starts as a task whatever `workspace.json` says, and the sessions already on disk stay exactly where they are until they are finished or archived.

The two-stage approach (CLI stages, skill applies) means upgrades are never automatic or silent. You see every change before it takes effect.

The baseline is what keeps repeat upgrades quiet: written at scaffold time and rewritten at the end of every update, it records the hash of every verbatim-installed file the template last shipped. Entries hold the payload's hash — even for a file you kept in your own version, which then reads as a purely local edit (listed for information) until the template changes it again — while an update you declined keeps the older entry so the change is offered again next time, and a file nobody touched is never mistaken for a local edit. Workspaces upgraded from versions before v0.21 have no baseline of their own; `--upgrade` reconstructs one from the installed version's published tarball and stages it in the payload (see above), the worktree-flow classification picks it up through `--baseline`, and the first update writes the real baseline inside the worktree — committed through the PR, so every clone gets it. Only when reconstruction fails does the first update fall back to asking about each changed file, writing the baseline for the next.

### How locally edited files are merged

A file you edited that the template also changed (`differs`) is not a choice between your version and the template's. The update merges it three-way, using the template files of the version being upgraded from — staged at `.workspace-update/.template-base/` by `--upgrade`, best effort — as the common ancestor. The helper (`template-merge.mjs`) runs `git merge-file` per file with your copy as "local", the staged base as the ancestor, and the payload's copy as "template"; a base is trusted only when its content hash matches the baseline's entry for that path, so a base that does not match what the baseline records is rejected (`noBase`) rather than merged against — which is also what happens to a file whose update you previously declined, since its baseline entry keeps the older version's hash. Merged text lands in `.workspace-update/.merged/`, mirroring each path — never directly in your file, and in your file's own line-ending and byte content (a CRLF working copy is handled line-ending-aware, non-UTF-8 bytes pass through untouched). Clean merges are shown as diffs and applied behind one batched confirmation; files with conflicts go one at a time: the skill shows the conflict hunks, proposes a resolution, and writes only after your approval for that file. When no base exists for a file — or the tarball could not be fetched at all, offline or unpublished — the file falls back to the two-way ask (show diff, apply, or keep).

### Recording deliberate divergences

`.claude/template-modifications.json` is the workspace's own registry of how it deliberately diverges from the template. It is a tracked file the template never ships and never overwrites — upgrades carry no copy of it, and it is never offered as a template removal — so it is entirely the workspace's to edit:

```json
{
  "localFiles": ["skills/my-skill/**"],
  "modifications": {
    "rules/git-conventions.md": "our trunk-based flow has no long-lived branches"
  }
}
```

Paths are relative to `.claude/` (a leading `.claude/` is tolerated and stripped when read, as are backslashes and a leading `./`). The registry covers `.claude/` paths only — root files like `CLAUDE.md`, `.mcp.json`, and `.claudeignore` are handled by their own merge paths — and a key that escapes `.claude/` (`../CLAUDE.md`, an absolute path) reports in the update output's `ignoredKeys` and in the maintenance audit, rather than sitting silently inert. The two fields answer different questions:

- **`localFiles`** — files the workspace owns outright, as exact paths or globs (`**` spans directories). Updates never offer them: no update ask, no removal ask. This replaces the old `workspace.json` → `workspace.localFiles` array, with unchanged semantics.
- **`modifications`** — deliberate edits to files the template still owns, each mapped to the reason it is kept. These files keep updating normally (three-way merge when both sides changed); the reason is simply shown whenever the file comes up for a decision, so "why does this file differ?" survives the person who made the edit.

The registry earns its keep through what the update flow does with it. Classification attaches each registered reason to the file's `differs`/`localOnly`/`deletedLocally`/`removed` entry and the merge helper carries it on its output, so every per-file decision shows why the divergence exists. When you keep your version of a file, the skill offers to record a reason. Registrations whose file has gone back to the template's content — you took the template's version at some point — are reported as stale and offered for removal, by the update (against the staged payload) and by `/maintenance audit` (against the baseline). And workspaces that predate the file keep their data in `workspace.json` (`workspace.localFiles`, or the improvised `workspace.templateModifications` map): both are still read for one release, flagged as `legacyKeys`, and migrated into the file — with your yes — by the next `/workspace-update`. A registry that doesn't parse fails closed: the update reports `modificationsError`, marks every template removal unverifiable, and stops to ask you to fix the JSON before any per-file decision.

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

The paths in this section are the ones a pre-v0.8.0 workspace had. `shared-context/` in particular is historical: it was renamed to `workspace-context/` in v0.15.0, and `/workspace-update` runs that migration on the way through.

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

4. **Smoke test** — as v0.8.0 behaved. A template from the task era behaves differently: `/start-work blank` starts a task, creating a worktree under `repos/{repo}/.claude/worktrees/` and no `work-sessions/` folder, and `/complete-work` finishes it from the chat at the workspace root.
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

The workspace-update-check hook runs at the start of every session and on every tool call. If a `.workspace-update/` directory exists, it injects a reminder into Claude's context. This means you will not forget about a pending update — Claude will mention it until you apply or dismiss it.

For teams, one person typically runs the upgrade and commits the result. The updated files — rules, skills, hooks, scripts — are tracked in git, so the rest of the team gets them on their next pull.

Custom rules, custom skills, and custom agents are not affected by upgrades. The template only manages its own files. Your additions are yours — and `.claude/template-modifications.json` records which files are yours outright (`localFiles`) and which template files you deliberately keep modified, with the reason why (see [Recording deliberate divergences](#recording-deliberate-divergences)).

---

## Key Takeaways

- `npx @ulysses-ai/create-workspace@beta --init` scaffolds a workspace with bootstrap skills, hooks, and scripts. The full template is staged for interactive installation.
- `/workspace-init` handles first-time configuration — cloning repos, installing template components, extracting team knowledge, activating rules, formalizing worktrees, setting user identity.
- Template versioning tracks which version of the template the workspace has.
- `--upgrade` stages changes, and refuses to stage an older template unless `--allow-downgrade` is passed; `/workspace-update` applies the staged changes interactively and verifies with a scripted post-update audit.
- Custom files are not affected by upgrades — the template manages only its own files.
