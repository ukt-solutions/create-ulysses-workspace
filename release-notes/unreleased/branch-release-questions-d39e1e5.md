---
branch: bugfix/migrate-rewrite
author: myron
date: 2026-04-02
---

## Open Questions

- workspace-init verification step caught cloud-infrastructure stale preamble but missed documentation.md referencing removed Notion MCP. Verification thoroughness needs testing across more scenarios.
- The upgrade mode (`--migrate --update`) replaces CLAUDE.md even when it's already template format. Should it compare content first?
- Migration recipes live in `.claude/recipes/` — should they be loaded into Claude's context automatically (like rules), or only read on demand by /workspace-init?
- Should workspace.json `templateVersion` be compared against a published registry, or just against the local package.json of whatever `create-claude-workspace` version is installed?
