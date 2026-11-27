# What Is a Workspace

A workspace is the operating environment for an AI-assisted project. It provides conventions for how work is organized, how context is shared, and how progress is tracked — without imposing a framework or runtime. Everything Claude needs is in the file system. Everything a team shares is in git.

This chapter introduces the workspace model: what the pieces are, how they fit together, and why the system works this way.

---

## The Core Idea

A workspace is a git repository that wraps your project repositories with shared conventions. It is not a monorepo — your project code stays in its own repos. The workspace adds structure around them: rules for Claude to follow, skills for common workflows, shared context for team knowledge, and hooks for automation.

The workspace root is a launcher, not a working directory. It stays on its default branch at all times. All real work happens in git worktrees that branch off for each piece of work — one worktree per repo the task touches. This separation means the root is always clean, always ready to launch new work, and never blocked by work in progress.

Think of it like a workbench. The workbench itself doesn't move — your tools and materials are arranged on it. When you start a project, you pull materials to a work area. When you finish, you clean up and the bench is ready for the next thing.

## Three Layers

A workspace operates on three layers, each serving a different scope:

**Template** is the upstream layer. It provides the default rules, skills, hooks, and scripts that ship with every workspace. When the template is updated, workspaces can pull in the changes. This layer is generic — it knows about workspace conventions but nothing about your specific project.

**Team workspace** is the project layer. It adds project-specific configuration: which repos to work with, team knowledge in `workspace-context/`, activated optional rules, custom skills. This layer is committed to git and shared across the team.

**Personal** is the individual layer. It includes `local-only-*` files, `CLAUDE.local.md`, personal settings, and the workspace scratchpad. This layer is gitignored — it exists only on your machine.

For solo developers, you use the template and personal layers. For teams, you use all three. The personal layer ensures that individual preferences and temporary state never pollute the shared workspace.

```
┌─────────────────────────────────────┐
│  Template (upstream, generic)       │  Rules, skills, hooks, scripts
├─────────────────────────────────────┤
│  Team Workspace (project, shared)   │  workspace.json, workspace-context/,
│                                     │  activated rules, custom skills
├─────────────────────────────────────┤
│  Personal (individual, gitignored)  │  local-only-* files, workspace-scratchpad/,
│                                     │  settings.local.json
└─────────────────────────────────────┘
```

## Directory Layout

A workspace has a predictable structure. With one task in flight, it looks like this:

```
my-workspace/
├── CLAUDE.md                   # Entry point — Claude reads this every turn
├── CLAUDE.local.md             # Per-user prompt — imports your own context index (gitignored)
├── workspace.json              # Configuration — repos, settings
├── repos/                      # Source clones of project repositories (gitignored)
│   ├── my-app/                 # Cloned project repo (stays on default branch)
│   │   └── .claude/worktrees/  # Task worktrees for this repo, one per branch
│   └── my-api/                 # Another project repo
├── workspace-context/          # Team and personal knowledge (tracked in git)
│   ├── shared/                 # Team-visible working documents
│   │   ├── locked/             # Canonical team truths — loaded every turn
│   │   └── milestones.md       # A team-visible working document
│   ├── team-member/            # One folder per person
│   │   └── alice/              # That person's working context
│   ├── canonical.md            # Generated: the contents of shared/locked/
│   └── index.md                # Generated: one line per file under shared/, canonical first
├── workspace-scratchpad/       # Machine-local files — session log, chat records (gitignored)
│   └── chats/                  # Per chat: its record and its drawer of in-progress designs and plans
└── .claude/                    # Configuration (tracked in git)
    ├── rules/                  # Behavioral constraints
    ├── skills/                 # Workflow commands
    ├── hooks/                  # Event automation
    ├── scripts/                # Helper scripts
    ├── lib/                    # Shared parser helpers
    ├── agents/                 # Subagent definitions
    └── worktrees/              # Task worktrees for the workspace repo itself (gitignored)
```

Each directory has one job:

**repos/** holds source clones of your project repositories. These are cloned here during setup and stay on their default branch — they are never disturbed by work. The whole directory is gitignored: the workspace tracks configuration, not code. A task's worktree for a project repo lives inside that repo's clone, at `repos/{repo}/.claude/worktrees/{slug}/`, where `{slug}` is the branch name with `/` replaced by `-`. That is the same location Claude Code's own worktree feature uses, so the two converge on one layout.

**.claude/worktrees/** is where a task's worktree for the workspace repo itself lives, at `.claude/worktrees/{slug}/`. A task creates one worktree per repo it touches, and the workspace repo can be one of them. Like every task worktree, it is removed when the task completes. [Chapter 2](02-work-sessions.md) covers tasks in detail.

**workspace-context/** is the memory system. Files here are tracked in git and shared across the team, apart from `local-only-*` drafts. It has three levels — `shared/locked/` for canonical team truths, `shared/` for team-visible working documents, and `team-member/{user}/` for each person's context — plus two generated catalogs, `canonical.md` and `index.md`, that CLAUDE.md imports. [Chapter 3](03-workspace-context.md) covers this in depth.

**workspace-scratchpad/** is machine-local and gitignored: the session log, hook debug output, and each chat's record and drawer. It is lazy-created. Losing it costs a re-derivation, not the work, with one exception: `session-log.jsonl` is a history no other file keeps.

**.claude/** holds all the configuration that makes the workspace work — rules Claude follows, skills for workflows, hooks for automation, scripts for mechanical sequences, the shared library helpers, and agent definitions for subagent dispatch. These are tracked in git so the whole team shares the same configuration.

## workspace.json

The workspace configuration file declares which repos belong to the workspace and sets workspace-level options:

```json
{
  "workspace": {
    "name": "my-workspace",
    "templateVersion": "0.28.0-beta.0",
    "versionCheck": { "ambient": true },
    "scratchpadDir": "workspace-scratchpad",
    "workspaceContextDir": "workspace-context",
    "alwaysLoadedBudgetBytes": 65536,
    "subagentContextMaxBytes": 32768,
    "subagentInlineMaxBytes": 8192,
    "tracker": null,
    "forge": { "type": "github" },
    "repoRemotes": true,
    "mergeApproval": "ask"
  },
  "repos": {
    "my-app": {
      "remote": "git@github.com:team/my-app.git",
      "branch": "main"
    },
    "my-api": {
      "remote": "git@github.com:team/my-api.git",
      "branch": "main"
    }
  }
}
```

The `repos` object is the manifest of project repositories. Each entry names a repo, its remote URL, and its default branch. Skills use this manifest to create worktrees, push branches, and create pull requests. When you start work, you choose which repos to include — it can span one or many.

The `workspace` object holds the directory locations and the template version, together with the settings the skills read: the issue tracker and the forge, whether the project clones are registered as remotes of the workspace repo (`repoRemotes`), and the context budgets. `/workspace-init` sets most of them, and you rarely need to touch them again. A workspace upgraded from an earlier version may also carry `sessionModel` and `workSessionsDir`, keys of the session lifecycle those versions had. The template no longer ships either. They stay in an older file because an update never removes a key: the first is read by nothing, and the second only names where leftover sessions sit. [VERSIONING.md](../../VERSIONING.md) documents every field.

`repoRemotes` is on unless it is `false`. On, every project clone is mirrored onto the workspace repo as a remote named `repo-{name}`, so that Claude Code Desktop can match a pull request in that project to a chat started at the workspace root; [Chapter 7](07-hooks-and-scripts.md#repo-remotesmjs) describes how. `false` removes what that added — the remotes the script created, and the hand-made ones it adopted — and leaves every other remote as it is.

## How Repos Relate to the Workspace

Your project code lives in its own repositories. The workspace does not contain your code — it wraps it. Repos are cloned into the `repos/` directory during setup, and they stay on their default branch at all times. When you start work, the workspace creates a worktree (a lightweight git checkout) for each repo the work touches, so the original clone is never disturbed. A task's worktrees sit under each repo's `.claude/worktrees/` — `repos/{repo}/.claude/worktrees/{slug}/`, or `.claude/worktrees/{slug}/` for the workspace repo itself.

This means you can run several pieces of work in parallel, each with its own set of worktrees, each on its own branch, without any conflict. One terminal can be working on a feature while another terminal fixes a bug — both in the same workspace, neither blocking the other.

The workspace repository and the project repositories are independent git repos. They share a branch name during the work for traceability (so you can find the corresponding workspace context for any project branch), but they have separate commit histories, separate origins, and separate pull requests. The one link git itself carries between them is a set of remotes on the workspace repo: each project clone appears there as `repo-{name}`, for pull-request matching only. Nothing is pushed to or fetched from those remotes.

## Convention Over Configuration

The workspace relies on naming conventions rather than configuration files or runtime logic. A file named `design-auth-system.md` is a spec. A file named `local-only-notes.md` is personal. A file ending in `.md.skip` is available but inactive. A file named `handoff_auth.md` under `workspace-context/` is a handoff. A directory named `chats/fix-login/` under the scratchpad is one chat's drawer.

These conventions are simple enough to memorize and consistent enough to automate. Hooks use naming patterns to detect state. Skills use naming patterns to find files. The maintenance skill uses naming patterns to identify stale artifacts. No registry, no database, no runtime — just files named in predictable ways.

This approach has a deliberate tradeoff: you trade the precision of explicit configuration for the simplicity of convention. A misconfigured database is a hard error. A misnamed file is a silent miss. The workspace compensates by making the conventions few, consistent, and well-documented — and by providing the `/maintenance` skill to catch drift.

---

## Key Takeaways

- A workspace wraps your project repos with shared conventions — it does not contain your code.
- The workspace root stays on its default branch. All work happens in worktrees: a task's under `repos/{repo}/.claude/worktrees/{slug}/` and `.claude/worktrees/{slug}/`.
- Three layers: template (generic), team workspace (shared), personal (gitignored).
- `workspace.json` declares which repos belong and configures workspace behavior.
- Convention over configuration — naming patterns do the heavy lifting, not runtime logic.
