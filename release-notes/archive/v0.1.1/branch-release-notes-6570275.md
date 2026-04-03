---
branch: bugfix/complete-work-inflight-cleanup
type: fix
author: myron
date: 2026-04-01
---

## Fix: /complete-work now fully cleans up inflight context

The /complete-work skill's Step 9 (Process workspace inflight context) previously marked branch handoffs as `lifecycle: resolved` but never specified what to do with them afterward. Resolved items accumulated in `shared-context/{user}/inflight/` indefinitely — a dead state that cluttered future sessions.

Step 9 now has explicit disposition rules for every file type: branch handoffs are either moved to ongoing (if they contain useful content beyond what the release notes captured) or deleted. Session braindumps are moved to ongoing if they cover broader topics or deleted if branch-specific. The key rule: **inflight/ must be empty after /complete-work completes.** Any remaining files trigger a prompt asking the user what to do.
