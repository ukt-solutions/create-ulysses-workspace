<p align="center">
  <img src="https://raw.githubusercontent.com/ukt-solutions/create-ulysses-workspace/main/docs/assets/logo.png" alt="Ulysses Workspace" width="220">
</p>

# @ulysses-ai/create-workspace

[![npm version](https://img.shields.io/npm/v/@ulysses-ai/create-workspace.svg)](https://www.npmjs.com/package/@ulysses-ai/create-workspace)

> Rules, skills, and hooks that steer Claude Code through real work. Sessions you can pause and resume, multi-repo with versioning, shared context that survives chat boundaries.

> **Beta.** Currently shipping as `0.13.0-beta.x` under the `@beta` dist-tag. Conventions and CLI flags are stable; the `latest` tag will appear when `0.13.0` cuts. Beta testers welcome — please [open an issue](https://github.com/ukt-solutions/create-ulysses-workspace/issues) if anything's confusing.

Requires Node 20.9 or later.

## Quick start

```bash
# npm
npm create @ulysses-ai/workspace@beta

# yarn
yarn create @ulysses-ai/workspace@beta

# pnpm
pnpm create @ulysses-ai/workspace@beta

# bun
bun create @ulysses-ai/workspace@beta
```

Then:

```bash
cd my-workspace
claude
/workspace-init
/start-work
```

## Migrate an existing project

Already have a project directory? Run `--init` from inside it with no target argument:

```bash
cd my-existing-project
npx @ulysses-ai/create-workspace@beta --init
```

The scaffolder treats the current directory as the workspace root. If a `CLAUDE.md` already exists, it's backed up to `CLAUDE.md.bak` and replaced with the workspace template — your old content is preserved for `/workspace-init` to extract from.

Then run `claude` and `/workspace-init`. The skill discovers any repos already present, asks which to register in `workspace.json`, prompts for any additional repos to add, extracts documentation from existing sources, and formalizes any in-progress git worktrees as work sessions. Then `/start-work` to begin.

## Upgrade an existing workspace

When a new template version ships, upgrade in place:

```bash
cd my-workspace
npx @ulysses-ai/create-workspace@beta --upgrade
```

This stages the new template payload to `.workspace-update/` without changing anything yet. Open Claude Code and run `/workspace-update` — the skill applies each change interactively (asks how to resolve any file you've customized) and runs a maintenance audit before and after.

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
| `npm create @ulysses-ai/workspace@beta` | Interactive scaffolder (recommended) |
| `npx @ulysses-ai/create-workspace@beta --init [dir]` | Non-interactive fresh install (pass dir directly) |
| `npx @ulysses-ai/create-workspace@beta --upgrade [dir]` | Apply template updates to an existing workspace |

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
