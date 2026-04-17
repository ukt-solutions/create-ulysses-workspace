# Solo Developer Guide

You use Claude Code for your projects. Maybe you have one repo, maybe a few. You want your work to have structure — tracked sessions, captured decisions, clean release notes — without the overhead of a team workflow. This guide walks you through setting up a workspace and running your first work session from start to finish.

---

## Step 1: Create Your Workspace

Open a terminal and scaffold a new workspace:

```bash
npx @ulysses/create-workspace --init my-workspace
cd my-workspace
```

You now have a workspace with all the conventions, skills, and hooks ready to go. The directory has a CLAUDE.md, a workspace.json, and a `.claude/` directory with everything Claude needs.

## Step 2: Add Your Repo

Open `workspace.json` and add your project repository:

```json
{
  "repos": {
    "my-app": {
      "remote": "git@github.com:you/my-app.git",
      "branch": "main"
    }
  }
}
```

Then clone it:

```bash
git clone git@github.com:you/my-app.git repos/my-app
```

Your project code is now inside `repos/my-app/`. The workspace wraps it — your code stays in its own repo with its own history.

## Step 3: Start Claude and Run Setup

```bash
claude
/workspace-init
```

The setup skill confirms your repos are cloned, lets you activate any optional rules you want (you can skip these for now), and configures your user identity.

## Step 4: Start Your First Work Session

```bash
/start-work
```

Since there are no active sessions, Claude asks what you are working on. Describe it — "Add user authentication" or "Fix the broken search endpoint." Claude generates a session name, proposes a branch, and asks you to confirm.

Once you confirm, the workspace creates:
- A self-contained session folder at `work-sessions/add-auth/`
- A workspace worktree at `work-sessions/add-auth/workspace/`
- A nested project worktree at `work-sessions/add-auth/workspace/repos/my-app/`
- A unified `session.md` tracker — frontmatter is machine state, body is human content

Claude tells you: "Work session started. Work from `work-sessions/add-auth/workspace/`."

## Step 5: Do Your Work

Now you work normally. Make changes in the project worktree, commit as you go. Claude is aware of your session — it knows which branch you are on, which repos are involved, and where the worktrees are.

As you work, you might make design decisions, encounter tradeoffs, or explore alternatives. When something worth preserving comes up, capture it:

```
/braindump
```

Claude synthesizes the recent discussion into the session tracker. You do not lose this context when the conversation ends.

If you need to back up your work without any ceremony:

```
/sync-work
```

This pushes your branches to the remote. No PRs, no lifecycle changes — just a checkpoint.

## Step 6: Complete the Session

When you are done:

```
/complete-work
```

Claude runs the full completion pipeline: rebases your branch, synthesizes release notes from everything the session accumulated (tracker, commits, any specs or plans), pushes the branch, creates a pull request, and asks if you want to merge.

```
Work session complete:

PROJECT: my-app
  PR #42: feat: add user authentication
  Branch: feature/add-auth → main
  Changes:
    - Added JWT-based auth middleware
    - Login and registration endpoints
  Release notes: branch-release-notes-abc123.md

WORKSPACE: my-workspace
  PR #3: context: add-auth work session
  Branch: feature/add-auth → main

Merge all? [Y/n]
```

Type `y` and everything merges. The worktrees are cleaned up. You are back on main, ready for the next thing.

## You Just Did a Full Cycle

That is the core loop: `/start-work` → work → `/complete-work`. Along the way, `/braindump` and `/sync-work` keep your context captured and your work backed up.

When you are ready to cut a release across multiple completed sessions, run `/release` to combine the accumulated branch notes into a versioned document.

## Where to Go Next

- [Chapter 1: What Is a Workspace](../chapters/01-what-is-a-workspace.md) — understand the workspace model and why it works this way
- [Chapter 2: Work Sessions](../chapters/02-work-sessions.md) — deep dive into sessions, worktrees, multi-repo, and parallel sessions
- [Chapter 10: Installation and Upgrades](../chapters/10-installation-and-upgrades.md) — template versioning and staying current
