# Solo Developer Guide

You use Claude Code for your projects. Maybe you have one repo, maybe a few. You want your work to have structure — tracked tasks, captured decisions, clean releases — without the overhead of a team workflow. This guide walks you through setting up a workspace and running your first task from start to finish.

---

## Step 1: Create Your Workspace

Open a terminal and scaffold a new workspace:

```bash
npx @ulysses-ai/create-workspace@beta --init my-workspace
cd my-workspace
git init
```

You now have a workspace. The directory has a CLAUDE.md, a workspace.json, and a `.claude/` directory holding the hooks and the two skills the next steps need; the rest of the template is staged beside them, for `/workspace-init` to install. The `git init` is there because `--init` does not do it, and `/workspace-init` works on a branch.

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

The setup skill offers to clone any repo that is not on disk yet, lets you activate any optional rules you want (you can skip these for now), and configures your user identity. New work is always a task, so there is no lifecycle to choose.

## Step 4: Start Your First Task

```bash
/start-work
```

With no issue tracker configured, Claude says tracking is off, then asks for a type (`feat`, `bug` or `chore`) and a one-line description. (With a tracker configured, you pick an issue from it or file a new one instead.) Describe it — "feat: add user authentication" or "bug: fix the broken search endpoint." Claude proposes a branch from the type and the description, `feature/add-auth`, and asks you to confirm.

Once you confirm, the workspace creates:
- A branch, `feature/add-auth`
- A worktree at `repos/my-app/.claude/worktrees/feature-add-auth/` — the branch name with `/` turned into `-`
- An entry for the task on this chat's record, in `workspace-scratchpad/chats/`

Claude tells you where the work happens. You stay in this chat at the workspace root and reach the worktree by path; the chat keeps the workspace's rules and hooks, which a chat started inside the worktree would not load.

## Step 5: Do Your Work

Now you work normally. Make changes in the worktree, commit as you go. Claude is aware of your task — it knows which branch you are on and where the worktree is.

As you work, you might make design decisions, encounter tradeoffs, or explore alternatives. When something worth preserving comes up, capture it:

```
/braindump
```

Claude writes the reasoning into this chat's drawer, `workspace-scratchpad/chats/`, and asks when the task completes whether any of it should move into `workspace-context/`. You do not lose this context when the conversation ends.

If you need to back up your work, commit it and push the task branch:

```bash
git -C 'repos/my-app/.claude/worktrees/feature-add-auth' push -u origin 'feature/add-auth'
```

## Step 6: Complete the Task

When you are done:

```
/complete-work
```

Claude runs the full completion pipeline: checks the worktree is clean, asks which drawer notes deserve to graduate into `workspace-context/`, rebases the worktree, writes a PR body from the commits and the captured thinking, pushes the branch, creates a pull request, and asks if you want to merge.

```
Task complete:

PROJECT: you/my-app
  PR: https://github.com/you/my-app/pull/42
  Checks: none
  Branch: feature/add-auth → main
  Commits: 3

Merge all? [Y/n]
```

Type `y` and it merges. The worktree is removed, the task leaves the chat's record, and you are back at the workspace root, ready for the next thing. With a tracker configured the linked issue would close here too; without one there is nothing to close.

## You Just Did a Full Cycle

That is the core loop: `/start-work` → work → `/complete-work`. Along the way, `/braindump` keeps your reasoning in the chat's drawer until completion asks what to keep.

When you are ready to cut a version, run `/release` — it bumps the version, merges the bump through a PR, tags it, and publishes a forge release whose notes are generated from the merged PRs.

## Where to Go Next

- [Chapter 1: What Is a Workspace](../chapters/01-what-is-a-workspace.md) — understand the workspace model and why it works this way
- [Chapter 2: Tasks](../chapters/02-work-sessions.md) — the task model in depth, worktrees, the chat record and drawer, multi-repo and parallel work
- [Chapter 10: Installation and Upgrades](../chapters/10-installation-and-upgrades.md) — template versioning and staying current
