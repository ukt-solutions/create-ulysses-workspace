# create-ulysses-workspace

[![npm version](https://img.shields.io/npm/v/create-ulysses-workspace.svg)](https://www.npmjs.com/package/create-ulysses-workspace)

> Rules, skills, and hooks that steer Claude Code through real work. Sessions you can pause and resume, multi-repo with versioning, shared context that survives chat boundaries.

## Quick start

```bash
# npm
npm create ulysses-workspace@latest

# yarn
yarn create ulysses-workspace

# pnpm
pnpm create ulysses-workspace

# bun
bun create ulysses-workspace
```

Then:

```bash
cd my-workspace
claude
/workspace-init
/start-work
```

## Why "Ulysses"?

Ulysses lashed himself to the mast so he could hear the Sirens without being steered into the rocks. A workspace does the same for Claude — freedom to do the work, constraints that keep it on course.

Rules say what's safe. Skills say how to do the recurring things. Hooks notice what would otherwise slip through. The combination is what gets you home.

## What it gives you

Four things, in the order you'll touch them:

1. **A workflow lifecycle that survives chat boundaries.** `/start-work` provisions a session — branch, worktree, tracker — atomically. `/pause-work` and `/sync-work` checkpoint mid-stream. `/complete-work` rebases, synthesizes release notes, opens PRs, and tears down. The same session resumes cleanly in a fresh chat.

2. **Parallel work sessions you can run from separate terminals.** Each session lives in its own folder under `work-sessions/{name}/` with its own workspace worktree and nested project worktrees. Two sessions can't collide on a branch or a working directory.

3. **Multi-repo support with versioning across repos.** A workspace wraps your project repos rather than replacing them. Each session can span one repo or many. `/release` synthesizes versioned release docs across the repos that contributed.

4. **Shared context with a locked layer that stays in the window.** `shared-context/locked/` is loaded every turn and injected into subagents. Team truths arrive in the model's context window without anyone remembering to paste them.

> Everything Claude needs is in the file system. Everything a team shares is in git.

## What you get

A scaffolded workspace with:

- **14 skills** covering the workflow lifecycle, releases, handoffs, and maintenance
- **6 active rules** + **8 optional `.skip` rules** for behaviors you can opt into
- **8 hooks** for SessionStart, SubagentStart, PreCompact, WorktreeCreate, and the rest of the small set the conventions rely on
- A **`shared-context/`** memory system with three visibility levels: locked (team truths), root (team-visible ephemerals), user-scoped (personal)
- Conventions for **multi-repo work sessions** with isolated git worktrees, parallelizable from separate terminals

(Counts are static prose, but a `prepublishOnly` audit script verifies them against the template at publish time — they don't drift.)

## CLI

| Command | What it does |
| --- | --- |
| `npm create ulysses-workspace@latest` | Interactive scaffolder (recommended) |
| `npx create-ulysses-workspace --init [dir]` | Non-interactive fresh install (pass dir directly) |
| `npx create-ulysses-workspace --upgrade [dir]` | Apply template updates to an existing workspace |

> **Why two forms?** `npm create <pkg>` resolves to `npx create-<pkg>`, but it consumes the `--init` flag for itself (npm's own subcommand alias). Use the bare `npm create` form for interactive scaffolding; use `npx` directly when you want to pass `--init <dir>` non-interactively.

## Documentation

Start here:

- **[Solo Developer Guide](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/guides/solo-developer.md)** — recommended starting point
- **[Team Lead Guide](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/guides/team-lead.md)**
- **[New Team Member Guide](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/guides/new-team-member.md)**

The eleven [chapters](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/) cover the model in depth — concepts, the toolkit, the release lifecycle, behavioral patterns:

| Part | Chapter | Topic |
|------|---------|-------|
| Concepts | [01](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/01-what-is-a-workspace.md) | What Is a Workspace |
| | [02](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/02-work-sessions.md) | Work Sessions |
| | [03](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/03-shared-context.md) | Shared Context |
| The Toolkit | [04](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/04-claude-md.md) | CLAUDE.md |
| | [05](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/05-rules.md) | Rules |
| | [06](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/06-skills.md) | Skills |
| | [07](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/07-hooks-and-scripts.md) | Hooks and Scripts |
| | [08](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/08-agents.md) | Agents |
| Lifecycle | [09](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/09-the-release-cycle.md) | The Release Cycle |
| | [10](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/10-installation-and-upgrades.md) | Installation and Upgrades |
| Practice | [11](https://github.com/ukt-solutions/create-ulysses-workspace/blob/main/docs/chapters/11-behavioral-patterns.md) | Behavioral Patterns |

## Status

In active pre-1.0 development. Used as dogfood and validated against external workspaces. Conventions and CLI flags are stable; small refinements continue. v1.0 will mark a stability commitment.

## License

MIT
