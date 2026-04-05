---
branch: feature/persistent-work-sessions
author: myron
date: 2026-04-05
---

## Open Questions

- The SessionStart hook does not register chat session IDs in the marker — that's deferred to `/start-work`. If a user opens a workspace worktree and works without running `/start-work`, the chatSessions array becomes inaccurate. Should the hook handle registration directly?

- Orphaned session marker cleanup is not explicitly added to the `/maintenance` skill. The existing stale worktree and inflight checks cover the same condition indirectly. Worth adding an explicit marker scan?

- The `create-work-session.mjs` script creates an absolute-path `rootPath` in `.active-session.json`. If the workspace is moved, the pointer breaks. `/start-work` can reconstruct from git state, but should the pointer use a relative path instead?

- Multi-repo work sessions (frontend + backend in one session) would require `repo` → `repos: []` in the marker schema. How much demand exists for this before committing to the schema change?

- History reconstruction depends on message history files in `~/.claude/projects/`. The path format and session ID matching haven't been validated against all Claude Code versions. Should this feature degrade gracefully if the files aren't found?

- Helper scripts consolidate ~12 bash calls into 2 script invocations, saving tokens. Should more mechanical sequences across other skills be scriptified? (See `shared-context/myron/script-candidates.md` for candidates.)
