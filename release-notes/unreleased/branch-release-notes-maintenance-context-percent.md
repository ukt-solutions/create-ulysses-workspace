---
branch: fix/maintenance-context-percent
type: fix
author: myron
date: 2026-04-19
---

## Maintenance health metric: locked/ size as % of context window

The `/maintenance` skill's health-metric bullet for `shared-context/locked/` previously flagged on absolute size (>10KB target). That heuristic doesn't survive contact with reality: a model with a 1M-token context window has very different headroom than one with 200K, and "10KB" is meaningless without that context.

The new metric is context-window-relative — flag if `locked/` exceeds 5% (yellow) or 15% (red) of the active model's context window. The bullet also names what actually matters more than total size: contradictions across files, stale references, and duplicated coverage. Absolute byte count is a weak proxy; those are the real signals.

The example output line in the skill's "Output Format" section was updated to match the new metric (`Locked context is 18% of model context window (red threshold: 15%)`).

Workspace's own `.claude/skills/maintenance/SKILL.md` mirrored to keep dogfood aligned with the template.
