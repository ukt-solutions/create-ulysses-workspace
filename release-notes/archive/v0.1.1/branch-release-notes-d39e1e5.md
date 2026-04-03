---
branch: bugfix/migrate-rewrite
type: feature
author: myron
date: 2026-04-02
---

## Migration Tool Rewrite and Workspace Init Skill

Rewrote the migration module (`lib/migrate.mjs`) to cleanly separate structure installation from content population. The migration tool (`--migrate`) installs template structure only: skills, hooks, rules, agents, recipes, settings, workspace.json, CLAUDE.md, git init. It sets `workspace.initialized: false` and stamps `templateVersion` from package.json. No content decisions, no remote creation, no pushing.

Added `--migrate --update` mode for upgrading existing template workspaces. Compares each file against the template, adds missing files, prompts before overwriting modified files, and preserves `local-only-*` files.

Created the `/workspace-init` skill — a guided brainstorming session that populates content after migration. Works on a branch (`chore/workspace-init`) with granular commits for reviewability. Identifies documentation sources (Notion, Confluence, markdown, etc.) before making a plan. Aggressively cleans the root directory by moving non-template items to `.claude-scratchpad/unmigrated/`. Runs a mandatory self-contradiction verification that checks all created rules and context files for references to removed services, stale paths, and conflicting statements. Reports all failures explicitly — nothing silently skipped. Ends by recommending a fresh session, not starting new work.

Added the Notion migration recipe (`.claude/recipes/migrate-from-notion.md`) as optional guidance for extracting Notion content during init. The migration tool detects Notion MCP servers and references the recipe in its post-migration report.

Added `templateVersion` field to workspace.json (stamped by both scaffold and migrate) to enable future upgrade comparisons.
