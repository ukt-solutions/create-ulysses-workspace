---
branch: chore/workflow-fixes
type: chore
author: myron
date: 2026-04-03
---

## Workflow maintenance and housekeeping

Consolidated the template's rule and skill system based on dogfood findings. Removed stale files, fixed broken hook paths, and renamed the audit skill to maintenance with broader cleanup capabilities.

### Skills
- Renamed `/audit` to `/maintenance` with three modes: `audit` (read-only integrity checks), `cleanup` (stale context, suggested merges, reconciliation), and full (both). Added context reconciliation as a retroactive check instead of inline in handoff/braindump.
- Removed capture-time cross-check from `/handoff` and `/braindump` skills — unreliable as an ambient prompt obligation, now lives in `/maintenance cleanup`.

### Rules
- Promoted `memory-guidance` from optional to mandatory. Added context capture prompts and session awareness sections (previously in the now-deleted `context-discipline` rule).
- Removed `context-discipline.md.skip` — content merged into `memory-guidance`.

### Hooks
- Fixed all hook paths to use `$CLAUDE_PROJECT_DIR` instead of relative paths. Relative paths fail because hooks don't run from the project directory — confirmed via debug log analysis.

### Scaffolder
- Updated optional rules list in `prompts.mjs` — removed `context-discipline` and `memory-guidance` (no longer optional).
