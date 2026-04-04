---
branch: chore/migrate-refactor
type: feature
author: myron
date: 2026-04-03
---

## CLI refactor — payload delivery mechanism and cross-platform hooks

Separated the CLI into a non-interactive payload delivery mechanism. The CLI no longer writes template files directly to the workspace or prompts interactively for file conflicts. Instead, it stages the full template into `.workspace-update/` and lets skills handle all interactive application.

### New CLI flags

Replaced `--migrate` / `--migrate --update` with `--init` and `--upgrade`:

- `--init [dir]` stages the template payload, creates a bare `workspace.json`, wires a bootstrap hook into `.claude/settings.json`, and adds temporary `@` imports to CLAUDE.md for mandatory rules. Non-interactive, idempotent.
- `--upgrade [dir]` verifies the workspace is initialized, stages the payload with version info, and exits. The `/workspace-update` skill handles the rest on the next Claude Code prompt.
- `--migrate` prints a deprecation error pointing to the new flags.

### Automatic bootstrap via hooks

A new `workspace-update-check.mjs` hook runs on both SessionStart and PreToolUse. It checks for a `.workspace-update/` payload directory and forces Claude to read and follow the appropriate skill (`/workspace-init` or `/workspace-update`) before doing anything else. This eliminates the "user must read terminal output and act" gap — the workspace bootstraps automatically on the next Claude Code interaction.

### Cross-platform hooks (bash → Node.js)

Converted all 7 existing template hooks from bash scripts to Node.js modules (.mjs). Node.js is already a prerequisite (the CLI is an npm package), so this adds no new dependencies while enabling Windows support. Created a shared utility module (`_utils.mjs`) with common hook patterns: reading stdin JSON, resolving workspace root, reading JSON files, and emitting JSON responses. This replaces the bash/python3/jq dependency chain.

Hooks converted: session-start, session-end, pre-compact, post-compact, subagent-start, repo-write-detection, worktree-create.

### Updated skills

Both `/workspace-init` and `/workspace-update` now read from the `.workspace-update/` payload directory instead of assuming files are already installed. They move components from the payload to their final locations with user approval, then delete the payload directory. The workspace-update skill also handles the one-time `.sh` → `.mjs` hook migration for workspaces upgrading from pre-0.2.0.

### Module structure

Replaced the monolithic `lib/migrate.mjs` (318 lines) with three focused modules: `lib/payload.mjs` (~40 lines, shared staging), `lib/init.mjs` (~60 lines, fresh install wiring), `lib/upgrade.mjs` (~20 lines, upgrade staging).
