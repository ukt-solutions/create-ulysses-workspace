# Open Work Tracking

Maintain a structured `shared-context/open-work.md` file that tracks all work items — bugs, features, chores. This file is the source of truth for what needs to be done. External systems (GitHub Issues, Linear, Jira) are presentation layers synced from this file.

## The File

`shared-context/open-work.md` lives at root level (team-visible). It contains one table per project repo, with each row being a work item:

```markdown
---
state: ephemeral
lifecycle: active
type: reference
topic: open-work
updated: {date}
---

# Open Work

## {repo-name}

| # | Type | Pri | Status | Branch | Title | Context |
|---|------|-----|--------|--------|-------|---------|
| 1 | bug | P1 | open | — | Auth timeout on mobile | shared-context/myron/auth-research.md |
| 2 | feat | P2 | in-progress | feature/search | Full-text search | — |
| 3 | chore | P3 | done | chore/cleanup | Remove deprecated endpoints | — |
<!-- gh-issue:repo#42 --> (optional: links row to external tracker)
```

### Fields

- **#** — sequential ID, unique within the repo table. Never reused.
- **Type** — `bug`, `feat`, or `chore`
- **Pri** — `P1` (critical/urgent), `P2` (important), `P3` (nice to have)
- **Status** — `open`, `in-progress`, `paused`, `done`
- **Branch** — the work session branch, or `—` if not started
- **Title** — short description
- **Context** — link to related braindump, handoff, or shared-context file

### External tracker markers

Items can be linked to an external tracker (GitHub Issues, Linear, etc.) using HTML comments below the row:
```
<!-- gh-issue:repo-name#42 -->
```
These markers are used by sync scripts to match items to external issues. The format depends on the tracker — `gh-issue` for GitHub, `linear` for Linear, etc.

## When to Update

### Adding items
- When a bug is discovered during work, add it
- When the user describes new work to do, add it
- When a braindump or discussion surfaces action items, add them
- Ask before adding: "Add this to open work? [Y/n]" — unless the user explicitly said "track this" or similar

### Updating status
- `/start-work` links a session to a work item → status becomes `in-progress`, branch field gets populated
- `/pause-work` → status becomes `paused`
- `/complete-work` → status becomes `done`
- These updates happen automatically as part of the skill flows

### Removing items
- Done items stay until `/release` clears them (they become part of the release notes)
- `/release` moves done items out of the table — they're captured in the versioned release document

### Priority changes
- Only change priority when the user explicitly reprioritizes
- Starting work on an item does not change its priority

## Sync

If `workspace.json` has a `tracker` configuration, the sync script runs as part of `/complete-work` after merging:

```json
{
  "workspace": {
    "tracker": {
      "type": "github-issues",
      "sync": ".claude/scripts/sync-open-work.mjs"
    }
  }
}
```

The sync script is workspace-specific — built during `/workspace-init` based on the team's chosen tracker. The template does not ship a sync script. The rule is: repo is source of truth, external tracker is the presentation layer. One-way sync only (repo → external).

## What This Rule Does NOT Do

- Does not enforce a specific external tracker — that's configured per-workspace
- Does not auto-create items without asking — bugs discovered during work get a confirmation prompt
- Does not manage the external tracker directly — that's the sync script's job
- Does not replace `/maintenance` for detecting stale items — maintenance audits the file alongside everything else
