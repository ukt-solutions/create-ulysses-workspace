---
branch: chore/multi-context-polish
type: feature
author: myron
date: 2026-04-15
---

## Project-scoped Playwright MCP in scaffolded workspaces

Scaffolded workspaces now ship with a project-scoped `.mcp.json` that registers Playwright MCP with `--output-dir workspace-scratchpad/playwright`. This replaces reliance on the global Claude Code Playwright plugin, which writes to `.claude-scratchpad/` and is shared across every project on the machine.

The global plugin is disabled at project scope via `enabledPlugins` in `.claude/settings.json` (set to `false` for `playwright@claude-plugins-official`). Users who want the plugin back in a specific workspace can re-enable it by setting the value to `true` in their project settings.

Traces, screenshots, and downloads land in the already-gitignored `workspace-scratchpad/` directory, so they stay scoped to the workspace that produced them and never leak into version control.
