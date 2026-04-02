---
branch: chore/improve-promote-skill
type: chore
author: myron
date: 2026-04-02
---

## Improve /promote skill — coded table and drop support

Redesigned the /promote skill to show all candidates from all sources (auto-memory, local-only context, local-only rules) in a single coded table with assessments and recommendations. Each candidate gets a code (AM1, LOC1, LOR1) so the user can make bulk decisions in one response: "Promote: LOC1, LOC3. Drop: AM1, AM2. Keep the rest."

Added drop support — the skill can now delete stale or redundant memory entries and local-only files, not just promote them. The assess-then-act flow gives the user the full picture before any action is taken.
