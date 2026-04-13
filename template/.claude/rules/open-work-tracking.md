# Open Work Tracking

Maintain a structured `shared-context/open-work.md` file that tracks all work items — bugs, features, chores — across all project repos in the workspace. This file is the source of truth for what needs to be done. External systems (GitHub Issues, Linear, Jira) are presentation layers synced from this file.

## Why Workspace-Level

Work items live in the workspace repo, not individual project repos. This is intentional:

- **Cross-cutting work** — a feature might touch multiple project repos. One ticket shouldn't live in three trackers.
- **Unified milestones** — release milestones span the whole product, not a single repo.
- **Single source of truth** — team members check one place to see what's open.

Issues sync to a workspace-level issue tracker (e.g., `{org}/workspace-{project}` on GitHub), not to individual project repos' trackers.

## The File

`shared-context/open-work.md` contains:

1. **Frontmatter** — standard shared-context frontmatter
2. **Intro paragraph** — documents the sync target, milestone short forms, default milestone
3. **Repo sections** — one `## {repo-name}` heading per project repo
4. **Ticket table** — scannable index, one row per ticket
5. **Details section** — H3 headings per ticket (`### #N — Title`) with root-cause analysis, file paths, proposed approach
6. **Tracker-state block** — machine-managed, maps ticket IDs to external issue numbers

```markdown
---
state: ephemeral
lifecycle: active
type: reference
topic: open-work
updated: {date}
---

# Open Work

Source of truth for all tracked work items. Synced to {tracker target} via `.claude/scripts/sync-open-work.mjs`. Milestone column uses short form; the sync script resolves these against full milestone titles. Tickets with `—` or empty milestone fall back to the default configured in `workspace.json` (currently `{default}`).

## {repo-name}

| #  | Type  | Pri | Milestone | Status      | Branch | Title |
|----|-------|-----|-----------|-------------|--------|-------|
| 1  | bug   | P1  | v0.1      | open        | —      | Auth timeout on mobile |
| 2  | feat  | P2  | v0.2      | in-progress | feature/search | Full-text search |
| 3  | chore | P3  | —         | done        | chore/cleanup | Remove deprecated endpoints |

### #1 — Auth timeout on mobile

Tokens are expiring at 15 minutes even though config says 60. Investigation points to refresh logic in `src/auth/refresh.ts:42` where the `expiresIn` field is being read as seconds instead of minutes.

### #2 — Full-text search

Users need to search product descriptions. Proposed approach: Postgres tsvector with a GIN index on the description column. Rejected Elasticsearch because the dataset is small.

<!-- tracker-state (managed by sync-open-work.mjs — do not edit)
#1 = gh:42
#2 = gh:43
#3 = gh:44
-->
```

### Table columns

| Column | Values | Notes |
|--------|--------|-------|
| **#** | integer | sequential within the workspace (not per-repo), unique, never reused |
| **Type** | `bug` / `feat` / `chore` | drives label on the external tracker |
| **Pri** | `P1` / `P2` / `P3` | drives label on the external tracker |
| **Milestone** | short form (e.g., `v0.1`, `v0.2`, `Backlog`) or `—` | resolved to full title at sync time; `—` falls back to default |
| **Status** | `open` / `in-progress` / `paused` / `done` | drives open/closed state on the external tracker |
| **Branch** | branch name or `—` | populated when a session is started on the ticket |
| **Title** | short description | becomes the issue title (prefixed with `[#N]`) |

### Details section

Tickets that need more than a title get an H3 detail section:

```markdown
### #N — Title

Detailed description, root cause, file paths, proposed approach.
```

The sync script extracts this via regex and uses the body as the external issue's description. Format is strict: `### #N — Title` (em-dash, not hyphen). The script uses a regex like `^### #(\d+)\s*—\s*[^\n]+\n\n([\s\S]+?)(?=^### #\d+|<!-- tracker-state|\Z)` to extract bodies between details.

### Tracker-state block

Machine-managed HTML comment at the end of the file. Maps ticket IDs to external issue numbers so the sync script knows which issues to update vs create. Never edit manually — the sync script rewrites it after every successful create.

```html
<!-- tracker-state (managed by sync-open-work.mjs — do not edit)
#1 = gh:42
#2 = gh:43
-->
```

The format inside the block depends on the tracker — `gh:N` for GitHub issue numbers, `linear:ABC-123` for Linear, etc. The sync script persists this block after every successful create so a mid-sync crash doesn't orphan issues.

## Milestones

Milestones are managed in the external tracker (GitHub Milestones, Linear Cycles, Jira Versions). The open-work.md Milestone column uses a **short form** that the sync script resolves to full titles.

The rule: **first whitespace-delimited token** of the milestone's full title is the short form.
- `"v0.1 — Alpha"` → short form `v0.1`
- `"v1.0 — Launch"` → short form `v1.0`
- `"Backlog"` → short form `Backlog`

This lets the milestone title carry context (themes, dates, stories) while keeping the table compact.

### Default milestone

`workspace.json` can configure a `defaultMilestone` in the tracker config:

```json
{
  "workspace": {
    "tracker": {
      "type": "github-issues",
      "sync": ".claude/scripts/sync-open-work.mjs",
      "defaultMilestone": "Backlog"
    }
  }
}
```

Tickets with `—` or an empty milestone cell get the default assigned at sync time. If no default is configured, they stay unmilestoned.

## When to Update

### Adding items
- When a bug is discovered during work, add it
- When the user describes new work to do, add it
- When a braindump or discussion surfaces action items, add them
- Ask before adding: "Add this to open work? [Y/n]" — unless the user explicitly said "track this"
- New items get the next available ID (highest + 1, unique across all repo tables)

### Updating status
- `/start-work` links a session to a work item → status becomes `in-progress`, branch field gets populated
- `/pause-work` → status becomes `paused`
- `/complete-work` → status becomes `done`, then sync runs
- These updates happen automatically as part of the skill flows

### Removing items
- Done items stay in the table until `/release` clears them (they're captured in the release notes)
- `/release` archives done items out of the table into the versioned release document

### Priority and milestone changes
- Only change priority when the user explicitly reprioritizes
- Only change milestone when the user explicitly assigns one (or the default kicks in for new items)
- Starting work on an item does not change its priority or milestone

## Sync

If `workspace.json` has a `tracker` configuration, the sync script runs as part of `/complete-work` after merging:

```bash
node .claude/scripts/sync-open-work.mjs
```

The sync script is workspace-specific — built during `/workspace-init` or added later via `/setup-tracker`. The template ships a reference implementation for GitHub Issues at `.claude/scripts/sync-open-work.mjs.reference` that `/setup-tracker` copies and activates when GitHub is chosen.

**Core principle:** repo is source of truth, external tracker is the presentation layer. One-way sync only (repo → external). Manual edits to issues on the external tracker will be overwritten on the next sync.

## What This Rule Does NOT Do

- Does not enforce a specific external tracker — that's configured per-workspace
- Does not auto-create items without asking — bugs discovered during work get a confirmation prompt
- Does not manage the external tracker directly — that's the sync script's job
- Does not create milestones in the external tracker — those are created manually, the sync only resolves them
- Does not replace `/maintenance` for detecting stale items — maintenance audits the file alongside everything else
