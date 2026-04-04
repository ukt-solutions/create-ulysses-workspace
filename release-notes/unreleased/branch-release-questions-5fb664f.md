---
branch: chore/migrate-refactor
author: myron
date: 2026-04-03
---

## Open Questions

- **Hook additionalContext reliability:** The bootstrap mechanism relies on Claude following MANDATORY instructions in `additionalContext`. This works in practice but isn't enforced by the platform. If Claude ignores the instruction, the workspace sits in a pending state.
- **PreToolUse performance:** The workspace-update-check hook fires on every tool call. It bails fast when no payload exists (single `existsSync` check), but the overhead on every tool call across every session is non-zero.
- **Node.js runtime requirement:** Hooks now require Node.js at runtime, not just install time. This is a new hard dependency. Should this be documented as a prerequisite, or is it safe to assume Node.js is present if the CLI was run via npx?
- **Pre-flag workspace migration:** Workspaces created before the `initialized` flag was introduced don't have `initialized: true`. The `--upgrade` command now accepts `templateVersion` as a fallback signal, but `/workspace-init`'s gate check may still reject them. Should `/workspace-init` also accept `templateVersion` as evidence of initialization?
