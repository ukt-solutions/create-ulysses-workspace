# Installation and Upgrades

A workspace starts with a scaffold command and evolves with template upgrades. The CLI creates the initial structure — directories, configuration files, rules, skills, hooks. When a new template version ships, the upgrade mechanism stages the changes and a skill applies them interactively. This chapter covers both paths.

---

## Scaffolding a New Workspace

To create a new workspace:

```bash
npx create-claude-workspace --init my-workspace
```

This creates the workspace directory with the full template: CLAUDE.md, workspace.json, rules, skills, hooks, scripts, agents, shared context structure, and gitignore. Git is initialized automatically.

If you omit the directory name, the current directory is used:

```bash
mkdir my-workspace && cd my-workspace
npx create-claude-workspace --init
```

After scaffolding, the workspace looks like this:

```
my-workspace/
├── CLAUDE.md
├── workspace.json
├── repos/                     (empty, gitignored)
├── shared-context/
│   └── locked/                (empty)
├── .claude-scratchpad/        (empty, gitignored)
└── .claude/
    ├── rules/                 (5 mandatory + 6 optional .skip)
    ├── skills/                (13 skills)
    ├── hooks/                 (8 hooks + _utils.mjs)
    ├── scripts/               (3 helper scripts)
    └── agents/                (4 agent definitions)
```

The scaffold is a starting point. It ships with sensible defaults, but everything is yours to customize — activate optional rules, add repos to workspace.json, populate locked context with team knowledge.

## First-Time Setup

After scaffolding, open the workspace in Claude Code and run `/workspace-init`:

```bash
cd my-workspace
claude
/workspace-init
```

The setup skill walks you through:

1. **Adding repos.** Edit workspace.json to declare your project repositories — name, remote URL, and default branch. The skill clones each repo into `repos/`.

2. **Activating optional rules.** Review the `.skip` rules and activate any that fit your team. Drop the `.skip` extension to activate.

3. **Configuring user identity.** Set your name for shared context authoring.

For solo use, setup is quick — one repo, maybe one or two optional rules. For teams, the team lead typically runs setup once and commits the result.

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

Or re-run `/workspace-init`, which will detect unclosed repos and offer to clone them.

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
npx create-claude-workspace --upgrade
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

## Staying Current

The workspace-update-check hook runs on every tool call. If a `.workspace-update/` directory exists, it injects a reminder into Claude's context. This means you will not forget about a pending update — Claude will mention it until you apply or dismiss it.

For teams, one person typically runs the upgrade and commits the result. The updated files — rules, skills, hooks, scripts — are tracked in git, so the rest of the team gets them on their next pull.

Custom rules, custom skills, and custom agents are not affected by upgrades. The template only manages its own files. Your additions are yours.

---

## Key Takeaways

- `npx create-claude-workspace --init` scaffolds a new workspace with the full template.
- `/workspace-init` handles first-time configuration — cloning repos, activating rules, setting user identity.
- Template versioning tracks which version of the template the workspace has.
- `--upgrade` stages changes; `/workspace-update` applies them interactively with maintenance before and after.
- Custom files are not affected by upgrades — the template manages only its own files.
