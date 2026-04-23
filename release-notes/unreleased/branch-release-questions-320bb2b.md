---
branch: feature/todowrite-session-mirror
author: myron
date: 2026-04-23
---

## Open Questions

- **Pre-existing dogfood drift on `require-node.mjs`.** The dogfood workspace's `.claude/lib/` is missing `require-node.mjs` that the template has. The dogfood works only because its older `trackers/interface.mjs` doesn't import the version guard. Surfaced by the Test C subagent run; this PR does not fix it. Worth a separate `chore` issue or a one-shot catch-up via `/workspace-update` once this PR ships.
- **GitHub renderer aesthetics for `[-]`.** GitHub renders `- [-]` as literal text rather than an interactive checkbox. Acceptable for `session.md` (which mostly lives on session branches and is read in editors), but if a user inspects a paused session's PR diff in the GitHub UI, the in-progress markers will look slightly off. Worth watching whether anyone notices.
