---
branch: feature/aside-skill
type: feature
author: myron
date: 2026-04-05
---

## `/aside` skill — drive-by idea capture

New skill for capturing stray ideas without interrupting the current conversation. Two modes:

- **Default (researched):** Dispatches the `aside-researcher` subagent in the background. The agent searches the workspace, project repos, and web, then writes a single `local-only-{slug}.md` file with the user's original thought preserved verbatim alongside its findings.
- **Quick (`--quick`):** No subagent. Writes the thought directly to a local-only file with a Further Investigation section.

Files are always `local-only-*` (gitignored), session-agnostic, and discoverable by `/promote` and `/maintenance`. The `variant: aside` frontmatter distinguishes them from other local-only files.

### New files
- `template/.claude/agents/aside-researcher.md` — Sonnet agent with Read/Glob/Grep/WebSearch/WebFetch/Write tools. Enforces the contract: research freely, write one file, touch nothing else.
- `template/.claude/skills/aside/SKILL.md` — Skill definition with quick and research mode flows, document templates, file naming, and lifecycle rules.

### Changes to existing files
- `template/.claude/skills/braindump/SKILL.md` — The `/braindump side` variant is deprecated and redirects to `/aside`.
