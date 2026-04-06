---
branch: feature/multi-repo-sessions
type: feature
author: myron
date: 2026-04-05
---

## Multi-Repo Work Sessions

Work sessions now bind to multiple project repos instead of one. A single session can span frontend + backend, app + platform, or any combination of repos defined in workspace.json.

### Schema Change

The session marker's `repo` field (string) is replaced by `repos` (array of strings). This is a breaking change — no backwards compatibility shim since the project has no external users.

The inflight tracker frontmatter follows the same pattern: `repo:` becomes `repos:` (comma-separated).

### Scripts

**create-work-session.mjs** now accepts a comma-separated `--repo` flag (e.g., `--repo "project-app,project-platform"`) and loops to create one worktree per repo. Output includes a `projWorktrees` array instead of a single `projWorktree`.

**cleanup-work-session.mjs** reads `marker.repos` and loops to remove all project worktrees and branches.

**add-repo-to-session.mjs** (new) adds a repo to an existing session mid-flight. Creates the branch and worktree, updates the session marker and inflight tracker. Supports the "didn't know I'd need this repo" scenario.

### Skills

Four skills updated to iterate over `marker.repos` instead of using a single `marker.repo`:

- **start-work:** Multi-repo selection in the blank flow, add-repo-to-session in the resume flow
- **complete-work:** Per-repo rebase, release notes, push, and PR creation. Atomic "Merge all?" prompt
- **pause-work:** Push and draft PR per project repo
- **sync-work:** Push loop across all project repos

### Hook

**repo-write-detection** extended to detect writes to repos that are in workspace.json but not in the active session. Returns an `additionalContext` nudge so Claude can offer to add the repo.

### Rule

**git-conventions.md** updated: "Work sessions get N+1 worktrees: one for the workspace, plus one per project repo."
