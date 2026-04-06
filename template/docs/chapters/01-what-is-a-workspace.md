# What Is a Workspace

A workspace is the operating environment for an AI-assisted project. It provides conventions for how work is organized, how context is shared, and how progress is tracked — without imposing a framework or runtime. Everything Claude needs is in the file system. Everything a team shares is in git.

This chapter introduces the workspace model: what the pieces are, how they fit together, and why the system works this way.

---

## The Core Idea

A workspace is a git repository that wraps your project repositories with shared conventions. It is not a monorepo — your project code stays in its own repos. The workspace adds structure around them: rules for Claude to follow, skills for common workflows, shared context for team knowledge, and hooks for automation.

The workspace root is a launcher, not a working directory. It stays on the `main` branch at all times. All real work happens in isolated worktrees that branch off for each work session. This separation means the root is always clean, always ready to launch a new session, and never blocked by in-progress work.

Think of it like a workbench. The workbench itself doesn't move — your tools and materials are arranged on it. When you start a project, you pull materials to a work area. When you finish, you clean up and the bench is ready for the next thing.

## Three Layers

A workspace operates on three layers, each serving a different scope:

**Template** is the upstream layer. It provides the default rules, skills, hooks, and scripts that ship with every workspace. When the template is updated, workspaces can pull in the changes. This layer is generic — it knows about workspace conventions but nothing about your specific project.

**Team workspace** is the project layer. It adds project-specific configuration: which repos to work with, team knowledge in shared context, activated optional rules, custom skills. This layer is committed to git and shared across the team.

**Personal** is the individual layer. It includes local-only files, personal settings, and the scratchpad. This layer is gitignored — it exists only on your machine.

For solo developers, you use the template and personal layers. For teams, you use all three. The personal layer ensures that individual preferences and temporary state never pollute the shared workspace.

```
┌─────────────────────────────────────┐
│  Template (upstream, generic)       │  Rules, skills, hooks, scripts
├─────────────────────────────────────┤
│  Team Workspace (project, shared)   │  workspace.json, shared-context/, 
│                                     │  activated rules, custom skills
├─────────────────────────────────────┤
│  Personal (individual, gitignored)  │  local-only-* files, .claude-scratchpad/,
│                                     │  settings.local.json
└─────────────────────────────────────┘
```

## Directory Layout

A workspace has a predictable structure. Every workspace looks like this:

```
my-workspace/
├── CLAUDE.md                  # Entry point — Claude reads this every turn
├── workspace.json             # Configuration — repos, settings
├── repos/                     # Project repositories and worktrees (gitignored)
│   ├── my-app/                # Cloned project repo (stays on default branch)
│   ├── my-api/                # Another project repo
│   ├── fix-auth___wt-workspace/    # Workspace worktree for a session
│   ├── fix-auth___wt-my-app/      # Project worktree for a session
│   └── fix-auth___wt-my-api/      # Another project worktree
├── shared-context/            # Team memory (tracked in git)
│   ├── locked/                # Team truths — always loaded
│   ├── myron/                 # User-scoped context
│   │   └── inflight/          # Active work session artifacts
│   └── milestones.md          # Team-visible ephemeral
├── .claude-scratchpad/        # Disposable files (gitignored)
├── .claude/                   # Configuration (tracked in git)
│   ├── rules/                 # Behavioral constraints
│   ├── skills/                # Workflow commands
│   ├── hooks/                 # Event automation
│   ├── scripts/               # Helper scripts
│   └── agents/                # Subagent definitions
└── release-notes/             # Version history (in project repos)
```

Each directory has one job:

**repos/** holds your project repositories. These are cloned here during setup, and worktrees are created here during work sessions. This entire directory is gitignored — the workspace tracks configuration, not code.

**shared-context/** is the memory system. Files here are tracked in git and shared across the team. It has three levels of visibility — locked for team truths, root for team-visible ephemerals, and user-scoped for individual context. [Chapter 3](03-shared-context.md) covers this in depth.

**.claude-scratchpad/** is for disposable files — session markers, temporary analysis, debug output. If you wouldn't care about losing it, it goes here. This directory is gitignored.

**.claude/** holds all the configuration that makes the workspace work — rules Claude follows, skills for workflows, hooks for automation, scripts for mechanical sequences, and agent definitions for subagent dispatch. These are tracked in git so the whole team shares the same configuration.

## workspace.json

The workspace configuration file declares which repos belong to the workspace and sets workspace-level options:

```json
{
  "workspace": {
    "name": "my-workspace",
    "templateVersion": "0.4.0",
    "scratchpadDir": ".claude-scratchpad",
    "worktreeSuffix": "___wt-",
    "sharedContextDir": "shared-context",
    "releaseNotesDir": "release-notes",
    "greeting": "Welcome back to my-workspace."
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

The `repos` object is the manifest of project repositories. Each entry names a repo, its remote URL, and its default branch. Skills use this manifest to create worktrees, push branches, and create pull requests. When you start a work session, you choose which repos to include — the session can span one or many.

The `workspace` object contains settings that control naming conventions, directory locations, and the template version. Most of these you set once during scaffolding and never touch again.

## How Repos Relate to the Workspace

Your project code lives in its own repositories. The workspace does not contain your code — it wraps it. Repos are cloned into the `repos/` directory during setup, and they stay on their default branch at all times. When you start a work session, the workspace creates worktrees (lightweight git checkouts) for each repo you're working with, so the original clone is never disturbed.

This means you can have multiple work sessions running in parallel, each with its own set of worktrees, each on its own branch, without any conflict. One terminal can be working on a feature while another terminal fixes a bug — both in the same workspace, neither blocking the other.

The workspace repository and the project repositories are independent git repos. They share a branch name during work sessions for traceability (so you can find the corresponding workspace context for any project branch), but they have separate commit histories, separate remotes, and separate pull requests.

## Convention Over Configuration

The workspace relies on naming conventions rather than configuration files or runtime logic. A file named `design-auth-system.md` is a spec. A file named `local-only-notes.md` is personal. A file ending in `.md.skip` is available but inactive. A directory named `fix-auth___wt-my-app` is a worktree for the `fix-auth` session's `my-app` repo.

These conventions are simple enough to memorize and consistent enough to automate. Hooks use naming patterns to detect state. Skills use naming patterns to find files. The maintenance skill uses naming patterns to identify stale artifacts. No registry, no database, no runtime — just files named in predictable ways.

This approach has a deliberate tradeoff: you trade the precision of explicit configuration for the simplicity of convention. A misconfigured database is a hard error. A misnamed file is a silent miss. The workspace compensates by making the conventions few, consistent, and well-documented — and by providing the `/maintenance` skill to catch drift.

---

## Key Takeaways

- A workspace wraps your project repos with shared conventions — it does not contain your code.
- The workspace root stays on `main`. All work happens in worktrees.
- Three layers: template (generic), team workspace (shared), personal (gitignored).
- `workspace.json` declares which repos belong and configures workspace behavior.
- Convention over configuration — naming patterns do the heavy lifting, not runtime logic.
