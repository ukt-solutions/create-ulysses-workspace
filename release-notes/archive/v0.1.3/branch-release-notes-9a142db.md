---
branch: chore/gitignore-fixes
type: fix
author: myron
date: 2026-04-03
---

## Fix: gitignore local-only glob and cleanup

Fixed the `local-only-*` gitignore pattern to use `shared-context/**/local-only-*` so it covers user-scoped directories (e.g., `shared-context/myron/local-only-*`). The previous pattern only matched root-level `shared-context/local-only-*`. Removed `.superpowers/` from gitignore so plugin artifacts get flagged by workflow for proper placement. Added `.idea/` for JetBrains IDEs.
