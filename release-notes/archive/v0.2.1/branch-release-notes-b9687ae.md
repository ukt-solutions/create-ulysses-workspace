---
branch: bugfix/workspace-update-stall
type: fix
author: myron
date: 2026-04-03
---

## Fix: workspace-update stall on pre-update audit

The pre-update maintenance audit in `/workspace-update` was a blocking gate — if the user didn't explicitly say "proceed" after audit findings, the update never happened. This created a loop where the hook would fire each session, the skill would audit, stall, and the session would end without applying the update.

Two fixes: the skill's pre-update audit is now informational only (always continues to Step 2), and the bootstrap hook detects stale payloads (>5 minutes old) and escalates urgency with instructions to skip the audit entirely.
