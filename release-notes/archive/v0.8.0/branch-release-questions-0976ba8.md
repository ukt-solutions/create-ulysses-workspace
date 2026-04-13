---
branch: feature/worksessions-refactor
author: myron
date: 2026-04-13
---

## Open Questions

No genuinely open questions. The design was comprehensive, all six open questions from the braindump were settled during the brainstorm phase, the implementation was reviewed and the review-driven cleanup pass addressed every blocking and moderate issue, and the two smoke-test findings from the throwaway workspace were fixed in-session. What remains are follow-ups rather than questions:

- **Existing workspaces still need the manual v0.8.0 upgrade.** Dogfood (ulysses-workspace itself), codeapy, and aegisprotect are all on pre-v0.8.0 layouts. The upgrade procedure is documented in chapter 10 but has not been run on any of them yet. Dogfood is the most urgent because it is where new work happens — running `/workspace-update` after this session merges is the immediate next step.
- **The release itself (v0.8.0 cut) is a separate operation.** This completion bumps `package.json` to 0.8.0 in the project repo but does not run `/release`. The release document synthesizing this branch note into a versioned v0.8.0 file is a subsequent step.
