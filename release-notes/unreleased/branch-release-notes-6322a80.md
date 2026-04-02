---
branch: feature/extended-hooks
type: feature
author: myron
date: 2026-04-01
---

## Extended Hooks and Workspace Convention Updates

Added PreCompact and PostCompact hooks to the template, expanding the hook system from two to four. PreCompact fires before context compression and prompts the user to capture decisions and progress via /braindump or /handoff before conversation details are lost. PostCompact fires after compression and reminds the user that earlier context was compacted.

Updated settings.json to wire all four hooks (SessionStart, SubagentStart, PreCompact, PostCompact). Fixed SessionStart to fire on both fresh starts and resumed sessions by removing the startup-only matcher, and increased the shared-context scan depth to find files in the new user/inflight/ directory structure.

Updated the workspace-structure rule to reflect the four-level shared-context convention: locked (team truths, always loaded), root (team-visible ephemerals), user-scoped (ongoing personal context), and user/inflight (current work-session artifacts consumed by /complete-work). Redefined .claude-scratchpad/ as truly disposable only — anything worth keeping belongs in shared-context. Added naming prefix conventions: design-* for specs, plan-* for plans.
