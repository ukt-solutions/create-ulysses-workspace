---
branch: fix/maintenance-context-percent
author: myron
date: 2026-04-19
---

## Open Questions

- **Implementation of the new metric.** The skill text describes the threshold but the actual measurement (looking up the active model's context window size) isn't implemented as code anywhere — it's prose for Claude to act on. Worth revisiting whether the audit should compute and surface a real percentage, or whether prose-as-instruction is enough.
