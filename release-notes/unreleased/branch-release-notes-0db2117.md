---
branch: feature/setup-tracker-skill
type: feature
author: myron
date: 2026-04-11
---

## Standalone /setup-tracker Skill

New skill at `.claude/skills/setup-tracker/` for configuring issue tracker sync with `shared-context/open-work.md`. Previously this logic was only available as Steps 12-13 during `/workspace-init`. Now it can be invoked standalone at any time via `/setup-tracker`.

The skill walks through: identifying the tracker system, researching integration approaches (MCPs, CLIs, APIs), setting up authentication, building a workspace-specific sync script, configuring workspace.json, and testing the sync. Supports GitHub Issues, Linear, Jira, Notion, and custom systems.

`/workspace-init` Step 13 now delegates to `/setup-tracker` instead of inlining the tracker setup logic. CLAUDE.md template updated with the new skill listing.
