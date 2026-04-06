# New Team Member Guide

You have just joined a project that uses a claude-workspace. There is a repo you need to clone, a setup to run, and a bunch of directories you have never seen before. This guide gets you oriented and working.

---

## Step 1: Clone the Workspace

Your team lead will give you the workspace repo URL. Clone it:

```bash
git clone git@github.com:team/team-workspace.git
cd team-workspace
```

You will see a directory with CLAUDE.md, workspace.json, shared-context/, and a `.claude/` directory. This is the workspace — it wraps your project repos with shared conventions.

## Step 2: Run Setup

Open Claude Code and run the setup skill:

```bash
claude
/setup
```

Setup clones the project repos listed in workspace.json into the `repos/` directory. It also asks for your name (used for shared context authoring) and shows you which optional rules are active.

After setup, your `repos/` directory has the project code:

```
repos/
├── frontend/
├── backend/
└── infrastructure/
```

These are normal git repos. The workspace adds structure around them but does not change how they work.

## Step 3: Get to Know the Workspace

Take a minute to look around. You do not need to memorize everything — it will make sense as you use it.

**CLAUDE.md** is the entry point. Open it and skim. It lists the available skills (the `/commands` you can run) and references the workspace config.

**shared-context/locked/** contains your team's knowledge. These files are loaded into every Claude conversation automatically. Open them — they will tell you what the project is, what architectural decisions have been made, and what is currently in focus. This is the fastest way to get project context.

**shared-context/** (the rest) contains working documents — braindumps, handoffs, research. These are the team's accumulated thinking. Browse if you are curious, but you do not need to read everything on day one.

**.claude/rules/** contains the behavioral rules Claude follows. These are conventions your team has established — how to handle git, how to revise documents, how to push back on bad ideas. They apply automatically.

## Step 4: Start Your First Work Session

When you are ready to do actual work:

```
/start-work
```

Claude asks what you are working on. Describe the task. Pick which repo (or repos) you need. Confirm the branch name. The workspace creates worktrees for you — isolated checkouts where your work happens without affecting anyone else.

```
Work session started. Work from repos/fix-bug___wt-workspace/.
```

Now work normally. Make changes, commit, iterate. Claude knows about your session and can help you navigate the project repos.

## Step 5: Capture as You Go

When you make a decision worth remembering — "we chose this approach because..." — capture it:

```
/braindump
```

Claude synthesizes the discussion into your session's tracker. This is how your reasoning survives between conversations. If you close this terminal and come back tomorrow, `/start-work` will offer to resume your session with all the context you captured.

## Step 6: Finish or Pause

When the work is done:

```
/complete-work
```

Claude rebases, writes release notes, creates pull requests, and offers to merge. It handles the full pipeline.

If you need to stop but are not finished:

```
/pause-work
```

This pushes your work, creates draft PRs, and marks the session as paused. Resume anytime with `/start-work`.

## You Are Set Up

That is all you need to start. The workspace handles the rest — hooks fire automatically to surface context, skills guide you through workflows, and shared context keeps the team's knowledge accessible.

As you work, you will naturally encounter the conventions. The workspace is designed to teach you by doing — each skill explains what it is doing as it runs.

## Where to Go Next

- [Chapter 1: What Is a Workspace](../chapters/01-what-is-a-workspace.md) — understand the workspace model, the three layers, and why the root stays on main
- [Chapter 3: Shared Context](../chapters/03-shared-context.md) — how team knowledge is organized, where your work lands, and how context flows
- [Chapter 11: Behavioral Patterns](../chapters/11-behavioral-patterns.md) — the habits that make the workspace work well — one topic per file, capture decisions, keep things clean
