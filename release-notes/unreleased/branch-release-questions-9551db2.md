---
branch: chore/design-debt-cleanup
author: myron
date: 2026-04-05
---

## Open Questions

- The workflow instructions removed from rules (context capture triggers, session awareness, commit timing) are not currently codified anywhere else. They existed as ambient guidance. Should any of them be formalized as dedicated skills or hooks? The PreCompact/PostCompact capture logic is already tracked as inventory items #15 and #16.

- The `{repo-branch}` placeholder in skills now points to workspace.json, but nothing validates that the field matches the actual remote default branch. If a repo's default branch changes on GitHub, workspace.json becomes stale silently. Worth adding a check during `/maintenance audit`?
