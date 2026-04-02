---
branch: chore/rename-sync-to-sync-work
type: chore
author: myron
date: 2026-04-01
---

## Rename /sync to /sync-work

Renamed the sync skill from `/sync` to `/sync-work` for consistency with the work session skill naming pattern: `/start-work`, `/pause-work`, `/complete-work`, `/sync-work`. The `-work` suffix signals these are work session lifecycle skills and makes intent-to-skill mapping clearer — "let's sync work" naturally maps to `/sync-work`.

Updated the skill directory name, the `name` field in SKILL.md frontmatter, internal references within the skill, and the CLAUDE.md template skills list.
