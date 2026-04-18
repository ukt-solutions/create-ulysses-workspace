---
branch: feature/node-runtime-check
type: feature
author: myron
date: 2026-04-18
---

## Hard Node 20.9+ requirement at workspace runtime

Before this change, the Node 20.9+ requirement was enforced only by the scaffolder (`bin/create.mjs`) at install time. Inside an installed workspace, hooks and helper scripts ran on whatever Node the user happened to have. On older Node, they would fail deep with cryptic syntax or feature errors instead of telling the user what was actually wrong.

A new tiny module — `template/.claude/lib/require-node.mjs` — runs the version check on import and exits non-zero with a clear message if Node is below 20.9. It's imported by:

- `template/.claude/hooks/_utils.mjs` — every hook already imports `_utils.mjs`, so this transitively gates all 8 hooks (post-compact, pre-compact, repo-write-detection, session-end, session-start, subagent-start, workspace-update-check, worktree-create).
- Each entry-point script in `template/.claude/scripts/` (5 scripts) and `template/.claude/scripts/trackers/` (2 modules) — these are invoked by skills via `node ...`, so they need their own first-line import.

Three scripts already imported `_utils.mjs` and were transitively gated; the explicit import in those is belt-and-braces but signals the requirement at the top of the file for anyone reading.

Test files (`*.test.mjs`) skip the import — they're dev-only and don't ship in production workflows.

The error message names the requirement, the actual Node version detected, and points the user at nvm/fnm/nodejs.org for an upgrade. Hooks and scripts exit 1 on bad Node; Claude Code surfaces stderr to the user as a hook failure.

This is the first published feature in the `0.13.0-beta` line and the first publish to ride the new CI workflow + npm trusted publishing rails.
