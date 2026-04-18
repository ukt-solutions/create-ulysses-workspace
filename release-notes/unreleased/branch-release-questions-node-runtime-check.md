---
branch: feature/node-runtime-check
author: myron
date: 2026-04-18
---

## Open Questions

- **Soft warn via SessionStart additionalContext** — deferred. The current design hard-exits hooks on bad Node (clear stderr, but somewhat abrupt). A SessionStart soft-warn would inject the warning directly into Claude's context so the user sees it in chat. Worth adding if the hard-exit UX turns out to surprise users in practice.

- **Existing workspaces won't get this until they `--upgrade`** — by design. The check ships in the template; users on older versions don't have it. Once codeapy and aegisprotect run `--upgrade` and apply v0.13.0-beta.1, they get the runtime check.
