---
name: setup-tracker
description: Configure an issue tracker for this workspace — writes workspace.json → tracker block and initializes labels. GitHub Issues is the only backend shipped; others can be added by dropping an adapter at .claude/scripts/trackers/{type}.mjs. Runnable during /workspace-init or standalone.
---

# Setup Tracker

Wire this workspace up to an external issue tracker. The tracker becomes the source of truth for all work items; the workspace does not maintain a local mirror.

## Prerequisites

- `.claude/rules/work-item-tracking.md` should be active. If missing, warn but continue.
- The adapter for the chosen backend must exist at `.claude/scripts/trackers/{type}.mjs`. The template ships `github-issues.mjs`.

## Flow

### Step 1: Check current state

Read `workspace.json` → `workspace.tracker`. If already configured: "Tracker is {type} on {repo}. Reconfigure? [y/N]." If declined, exit.

### Step 2: Pick a backend

Ask: "Which issue tracker?"
1. GitHub Issues (shipped)
2. Linear — not yet supported
3. Jira — not yet supported
4. None — skip

For (2) and (3): tell the user the adapter isn't shipped and exit. To add one, write a module at `.claude/scripts/trackers/{type}.mjs` that implements the contract in `.claude/scripts/trackers/interface.mjs`.

For (4): exit — no changes.

### Step 3: GitHub Issues configuration

1. **Verify `gh` auth.** Run `gh auth status`. If not authenticated, walk the user through `gh auth login`. Do not proceed until authenticated.

2. **Resolve the target repo.** Default to the workspace's own git remote:
   ```bash
   git -C {workspace-root} remote get-url origin
   ```
   Parse the GitHub slug. Ask: "Use `{slug}` for issues, or a different repo?" If the user wants a different repo, accept any `owner/name` slug.

3. **Verify issues are enabled:**
   ```bash
   gh repo view {slug} --json hasIssuesEnabled
   ```
   If `hasIssuesEnabled` is `false`, offer: "Issues are disabled on `{slug}`. Enable? [Y/n]" → `gh api repos/{slug} -X PATCH -f has_issues=true`.

4. **Write `workspace.json`:**
   ```json
   {
     "workspace": {
       "tracker": {
         "type": "github-issues",
         "repo": "{slug}"
       }
     }
   }
   ```
   Preserve all other fields. Commit:
   ```bash
   git add workspace.json
   git commit -m "chore: configure github-issues tracker on {slug}"
   ```

5. **Initialize labels** by calling the adapter's `ensureLabels()` from a shell one-liner:
   ```bash
   node --input-type=module -e "
     import { createTracker } from './.claude/scripts/trackers/interface.mjs';
     import { readFileSync } from 'node:fs';
     const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
     const t = createTracker(ws.workspace.tracker);
     await t.ensureLabels();
     console.log('Labels initialized.');
   "
   ```
   Creates the six standard labels: `bug`, `feat`, `chore`, `P1`, `P2`, `P3`.

6. **Optional: create milestones.** Ask if the user wants a starter milestone list (e.g., `Backlog`, `v0.1 — Alpha`, `v1.0 — Launch`). If yes, for each one:
   ```bash
   gh api repos/{slug}/milestones -X POST -f title="Backlog" -f description="Triaged later"
   ```
   Skip if the user declines — milestones can be added anytime via the GitHub UI or `gh api`.

7. **Verify:**
   ```bash
   gh issue list --repo {slug} --limit 5
   ```
   Expected: empty list (no tickets yet) or the existing ones if the repo already had issues.

### Step 4: Report

```
Tracker configured:
  Type: github-issues
  Repo: {slug}
  Labels: bug, feat, chore, P1, P2, P3
  Milestones: {list or "(none — add via GitHub UI or gh api)"}

Next: run /start-work to pick or create an issue and begin.
```

## Notes

- The workspace repo is the default target — no separate `workspace-{project}` repo needed.
- Issues track everything across all project repos in the workspace. Cross-repo work items live in one place.
- One-way integration: the tracker is the source of truth. Skills read and write via the adapter; nothing else reflects tracker state locally.
- If `gh auth login` later expires, skill flows will surface `gh` errors — re-run `gh auth login` and try again.
- Adding a new backend: write an adapter module at `.claude/scripts/trackers/{type}.mjs` implementing the interface in `interface.mjs`, then add a case in the `createTracker` switch statement.
