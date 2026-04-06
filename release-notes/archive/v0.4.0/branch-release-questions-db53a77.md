---
branch: feature/multi-repo-sessions
author: myron
date: 2026-04-05
---

## Open Questions

- **add-repo-to-session untested with real multi-repo workspace.** The script was written and reviewed but the integration test only verified single-repo create/cleanup. Full multi-repo testing requires a workspace with multiple repos in workspace.json (like the codeapy workspace).

- **Repo-write-detection hook path matching.** The hook extracts repo names from file paths using a regex. Edge cases with repo names containing special characters or nested paths haven't been tested.
