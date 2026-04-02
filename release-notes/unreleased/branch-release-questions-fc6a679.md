---
branch: chore/improve-promote-skill
author: myron
date: 2026-04-02
---

## Open Questions

- Work session markers are per-branch. Multiple Claude Code sessions on the same branch share the marker. Should markers include session/process IDs for true per-session tracking?
- What happens to orphaned markers when a session exits without /complete-work or /pause-work? The /audit skill could detect these, but should SessionEnd hook also clean up?
- The repo-write detection hook reads JSON from stdin on PreToolUse. The actual JSON structure from Claude Code hasn't been tested — field names (tool_name, tool_input, file_path) are assumed.
