---
branch: feature/token-economics-sharpening
author: myron
date: 2026-04-20
---

## Open Questions

- **Should we expand the hook's pattern list to detect `tar -t` on large archives, `npm ls` without a filter, or `docker logs` without `--tail`?** Three candidates surfaced during pattern brainstorming but were held back to keep the initial set tight. Decide after the hook has been live in a real workspace for a release cycle and there's evidence about what actually fires.
- **Should the rule's "Compaction Awareness" section include a numeric trigger (e.g., "if remaining context is below 20% and the conversation includes uncaptured decisions, run /handoff")?** The current text is qualitative. Quantifying it would help the model self-trigger more consistently, but locks in a threshold that varies by model context size.
