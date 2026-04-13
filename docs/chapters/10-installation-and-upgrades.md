# Installation and Upgrades

A workspace starts with a scaffold command and evolves with template upgrades. The CLI creates the initial structure — directories, configuration files, rules, skills, hooks. When a new template version ships, the upgrade mechanism stages the changes and a skill applies them interactively. This chapter covers both paths.

---

## Scaffolding a New Workspace

To create a new workspace:

```bash
npx create-ulysses-workspace --init my-workspace
```

The CLI installs the bootstrap essentials: CLAUDE.md (generated from template), workspace.json, the workspace-init and workspace-update skills, all hooks, all scripts, the shared library helpers, shared-context directory structure, and gitignore. The remaining skills, rules, and agents are installed interactively by `/workspace-init`. The `repos/`, `work-sessions/`, and `workspace-scratchpad/` directories are lazy-created when they first need to hold something.

If you omit the directory name, the current directory is used — this supports initializing an existing project directory as a workspace:

```bash
cd my-existing-project
npx create-ulysses-workspace --init
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
npx create-ulysses-workspace --upgrade
```

The upgrade does not apply changes directly. Instead, it stages a payload:

1. The CLI compares the workspace's current template version against the latest.
2. It determines which files are new, modified, or removed.
3. It writes the staged payload to `.workspace-update/` with a manifest of what changed.

The `.workspace-update/` directory is a staging area. No files have been modified yet. The actual application happens interactively through the `/workspace-update` skill.

## Applying Updates

After the CLI stages an upgrade, the workspace-update-check hook detects the `.workspace-update/` directory on the next tool call and nudges Claude to run `/workspace-update`.

The `/workspace-update` skill applies the staged changes interactively:

1. **Runs maintenance audit** before applying. This captures the workspace's state before the update so any issues can be attributed correctly.

2. **Presents changes.** Shows what will be added, modified, and removed. For modified files, shows the diff.

3. **Applies with confirmation.** Each change is applied with your approval. If a file has local customizations, you are asked how to resolve — accept the update, keep your version, or merge.

4. **Updates templateVersion.** Sets workspace.json's templateVersion to the new version.

5. **Runs maintenance audit** after applying. This catches any drift or issues introduced by the update.

The two-stage approach (CLI stages, skill applies) means upgrades are never automatic or silent. You see every change before it takes effect.

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

- `npx create-ulysses-workspace --init` scaffolds a workspace with bootstrap skills, hooks, and scripts. The full template is staged for interactive installation.
- `/workspace-init` handles first-time configuration — cloning repos, installing template components, extracting team knowledge, activating rules, formalizing worktrees, setting user identity.
- Template versioning tracks which version of the template the workspace has.
- `--upgrade` stages changes; `/workspace-update` applies them interactively with maintenance before and after.
- Custom files are not affected by upgrades — the template manages only its own files.
