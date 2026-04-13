---
branch: feature/open-work-tracking
type: feature
author: myron
date: 2026-04-11
---

## Open Work Tracking

Added a structured work item tracking system built around `shared-context/open-work.md`. The file is the source of truth for all bugs, features, and chores. External issue trackers (GitHub Issues, Linear, Jira) are presentation layers synced one-way from this file.

### Rule: open-work-tracking.md (mandatory)

Defines the `open-work.md` format — one table per repo with fields for ID, type, priority (P1/P2/P3), status (open/in-progress/paused/done), branch, title, and context links. External tracker markers (`<!-- gh-issue:repo#N -->`) link rows to issues. The rule tells Claude to add items when bugs are discovered or work is described, and to update status as sessions progress.

### Skill integrations

**start-work** now presents open work items sorted by priority when starting a new session. Users pick an existing item or describe something new (which gets added to the list). The session marker gets a `workItem` field linking to the item ID. Status updates to `in-progress` and the branch field is populated.

**complete-work** marks the linked work item as `done` after merging. If `workspace.json` has a `tracker.sync` script configured, it runs the sync to push updates to the external tracker.

**pause-work** marks the linked work item as `paused`.

### workspace-init integration

Two new steps in the initialization flow: Step 12 populates `open-work.md` from braindumps, chat history, formalized worktrees, and user input. Step 13 guides the user through setting up external tracker sync — identifying their system, researching MCPs or APIs, building a sync script, and configuring the `tracker` field in workspace.json.

### workspace.json

Added a `tracker` field (default `null`). When configured, it holds the tracker type and sync script path:
```json
{ "tracker": { "type": "github-issues", "sync": ".claude/scripts/sync-open-work.mjs" } }
```
