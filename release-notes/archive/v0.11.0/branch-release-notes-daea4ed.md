---
branch: chore/issue-tracking
type: feature
author: myron
date: 2026-04-17
---

## v0.11.0 — Tracker abstraction

The workspace's issue tracking is no longer file-based. `shared-context/open-work.md` is gone; work items live in an external tracker reached through a pluggable adapter. Atomic assignment on `/start-work` prevents concurrent pickup, and status is real-time — no more waiting on commit + push + CI for the team to see changes.

### What changed

- **Adapter interface** at `.claude/scripts/trackers/interface.mjs`. Skills import from this file; concrete backends live as siblings (e.g., `github-issues.mjs`).
- **GitHub Issues adapter shipped** as the default backend. Wraps `gh` CLI via an injectable `spawnFn` for unit tests.
- **`/setup-tracker`** rewritten. Writes `workspace.tracker` block into `workspace.json`, initializes the six standard labels (`bug`, `feat`, `chore`, `P1`, `P2`, `P3`) via `adapter.ensureLabels()`.
- **`/start-work`** now fetches assigned-to-me first, falls back to unassigned, and atomically claims the picked issue via `adapter.claim()`. This is the concurrency fix.
- **`/pause-work`** posts a pause comment on the linked issue instead of editing `open-work.md`.
- **`/complete-work`** closes the linked issue after PRs merge instead of updating `open-work.md` and running a sync script.
- **`/workspace-init`** drops the `open-work.md` population step; points to `/setup-tracker` for backend configuration.
- **Migration script** at `.claude/scripts/migrate-open-work.mjs` — one-shot tool that reads any existing `open-work.md` and creates issues via the configured adapter. For workspaces upgrading from v0.10 or earlier.

### Breaking changes

- `shared-context/open-work.md` is no longer created or maintained by any skill. Existing workspaces should run the migration script once, then delete the file.
- `sync-open-work.mjs.reference` is removed from the template. Workspaces that copied it should delete it.
- `workspace.json` → `workspace.tracker.sync` field is ignored. The adapter path is conventional (`.claude/scripts/trackers/{type}.mjs`). The new field is `workspace.tracker.repo`.
- `.claude/rules/open-work-tracking.md` is replaced by `work-item-tracking.md`. During upgrade, delete the old file and add the new one.
- Session trackers' `workItem:` frontmatter now holds adapter-prefixed IDs (`gh:42`) instead of internal integer IDs. Old sessions with integer `workItem:` values will fail to lookup — migrate by opening the corresponding issue for that old ID on GitHub and replacing the frontmatter value with the adapter-prefixed form.

### Upgrade guide for existing workspaces

1. `npx create-ulysses-workspace --upgrade` to stage the v0.11 payload.
2. Run `/workspace-update` to apply template changes.
3. If the workspace had `open-work.md`, run `/setup-tracker` to configure GitHub Issues on the workspace repo.
4. Run `node .claude/scripts/migrate-open-work.mjs shared-context/open-work.md workspace.json` from the workspace root.
5. Delete `shared-context/open-work.md` and commit.
