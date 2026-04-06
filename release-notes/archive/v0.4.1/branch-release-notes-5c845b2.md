---
branch: bugfix/patch-fixes
type: fix
author: myron
date: 2026-04-06
---

## Patch Fixes

**Inflight tracker cleanup (#53):** `/complete-work` Step 6 now removes the inflight tracker (`shared-context/{user}/inflight/session-{name}.md`) after synthesizing release notes. Previously, the tracker was left behind — worktrees, branches, and session markers were cleaned up, but the inflight file accumulated across sessions.

**Brainstorming pipeline (#54):** `/start-work` now detects prior conversation discussion (brainstorming, spec writing, design decisions) and captures a summary into the inflight tracker after session creation. Previously, reasoning that happened before `/start-work` was never captured, causing `/complete-work` to produce thin release notes missing design context.

**README:** Added a README with quick start instructions and a documentation table linking to all 11 chapters and 3 guides.
