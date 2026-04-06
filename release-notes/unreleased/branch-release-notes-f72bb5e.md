---
branch: bugfix/version-bump
type: fix
author: myron
date: 2026-04-06
---

## Package Version Sync

Fixed package.json version not being updated during releases. The CLI reads `package.json` to determine the template version for upgrades, so a stale version causes incorrect "already up to date" messages and wrong version numbers in staged payloads.

Bumped package.json from 0.2.1 to 0.4.1 to match the current release. Added a Step 7b to the `/release` skill that bumps package.json as part of the release flow, preventing this drift from recurring.
