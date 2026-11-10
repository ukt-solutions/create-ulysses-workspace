# New Team Member Guide

You have just joined a project that uses a Ulysses workspace. A teammate has already initialized it and pushed it; your job is to clone it, set up your own machine, and start working. This guide gets you there.

---

## Step 1: Clone the Workspace

Your team lead gives you the workspace repo URL. Clone it:

```bash
git clone git@github.com:team/team-workspace.git
cd team-workspace
```

You will see `CLAUDE.md`, `workspace.json`, `workspace-context/` and a `.claude/` directory. This is the workspace — it wraps your project repos with shared conventions. The project repos themselves are not in the clone yet; `repos/` is empty on purpose, because each person keeps their own clones.

## Step 2: Join

Open Claude Code at the workspace root and run the setup skill:

```bash
claude
```

```
/workspace-init
```

Claude Code's session-start hook will already have told you that setup is incomplete. `/workspace-init` sees that the workspace is initialized and runs as a **join**: it sets up only what your machine is missing.

- **Your name** — used for your personal context folder, `workspace-context/team-member/{you}/`. It is saved to `.claude/settings.local.json`.
- **Project repos** — each repo listed in `workspace.json` is cloned into `repos/`.
- **`CLAUDE.local.md`** — your personal prompt file, which loads your own context into every session.

All three are gitignored. A join changes nothing your teammates see, so there is nothing to commit or push. To force the join flow, run `/workspace-init join`.

When it finishes, **restart Claude Code** so your `CLAUDE.local.md` and the hooks load.

After the join, `repos/` holds the project code:

```
repos/
├── frontend/
├── backend/
└── infrastructure/
```

These are normal git clones and stay on their default branch. Your work happens in worktrees that the workspace creates for you.

### Doing it by hand

If you would rather not use the skill, the join is five commands:

```bash
git clone <remote> repos/<name>          # once per repo in workspace.json
mkdir -p .claude workspace-context/team-member/<you>
echo '{"workspace":{"user":"<you>"}}' > .claude/settings.local.json
node .claude/scripts/generate-claude-local.mjs
claude
```

## Step 3: Get to Know the Workspace

Take a minute to look around. You do not need to memorize everything — it will make sense as you use it.

**`CLAUDE.md`** is the entry point. It lists the available skills (the `/commands` you can run) and imports the team's knowledge.

**`workspace-context/shared/locked/`** holds your team's canonical knowledge. These files are loaded into every Claude conversation through `workspace-context/canonical.md`. Read them first — they tell you what the project is, which decisions are settled, and what is in focus.

**`workspace-context/shared/`** (the rest) holds working documents — braindumps, research, designs. Browse when you are curious; you do not need to read them all on day one.

**`workspace-context/team-member/{you}/`** is yours. Personal braindumps and handoffs land here and load only into your sessions.

**`.claude/rules/`** contains the behavioural rules Claude follows — git conventions, how to revise documents, when to push back. They apply automatically.

## Step 4: Start Your First Task

When you are ready to do actual work:

```
/start-work
```

What happens next depends on the lifecycle your team chose in `workspace.json` → `workspace.sessionModel`.

- **Task lifecycle (`"task"`)**: you pick an issue from the team's tracker, or describe new work and it files one. The workspace creates one branch and one worktree per repo the task touches, under `repos/{repo}/.claude/worktrees/{slug}/` (the branch name with `/` turned into `-`). Your chat stays at the workspace root and reaches the worktrees by path.
- **Session lifecycle (`"session"`)**: the workspace creates a self-contained folder at `work-sessions/{name}/` with its own workspace worktree and nested repo worktrees.

Either way, your work is isolated from everyone else's until it merges.

## Step 5: Capture as You Go

When you make a decision worth remembering — "we chose this approach because…" — capture it:

```
/braindump
```

Claude writes the reasoning down so it survives between conversations. `/handoff` captures where you are and what is next, so tomorrow's session picks up where today's stopped.

## Step 6: Finish or Pause

When the work is done:

```
/complete-work
```

Claude rebases, opens pull requests with a description of the change, merges once you approve, and closes the linked issue.

If you need to stop but are not finished:

```
/pause-work
```

This pushes your work and opens draft pull requests. Resume any time with `/start-work`.

## You Are Set Up

The workspace handles the rest — hooks surface context when a session starts, skills guide you through each workflow, and `workspace-context/` keeps the team's knowledge in one place. Each skill explains what it is doing as it runs, so the conventions teach themselves as you use them.

## Where to Go Next

- [Chapter 1: What Is a Workspace](../chapters/01-what-is-a-workspace.md) — the workspace model, its layers, and why the root stays on main
- [Chapter 3: Shared Context](../chapters/03-shared-context.md) — how team knowledge is organized and where your work lands
- [Chapter 11: Behavioral Patterns](../chapters/11-behavioral-patterns.md) — the habits that make the workspace work well
