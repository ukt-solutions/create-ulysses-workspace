---
name: setup-tracker
description: Set up issue tracker sync for open-work.md. For GitHub, copies the reference sync script and guides milestone creation. For other trackers, builds a custom sync script. Callable anytime — not just during workspace-init.
---

# Setup Tracker

Configure sync between `shared-context/open-work.md` and an external issue tracker (GitHub Issues, Linear, Jira, Notion, etc.). The template ships a working GitHub Issues reference implementation — for GitHub, this skill is mostly a copy + configuration exercise. For other trackers, the skill guides building a custom sync script.

This skill can be run during `/workspace-init` (Step 13) or standalone at any time.

## Prerequisites

- `shared-context/open-work.md` should exist. If it doesn't, create it first with the default structure (see Step 8).
- The open-work-tracking rule should be active (`.claude/rules/open-work-tracking.md`). If it's missing, warn: "The open-work-tracking rule is not installed. The tracker sync will work but items won't be maintained automatically."

## Flow

### Step 1: Check current state

Check if a tracker is already configured:
```bash
cat workspace.json | grep '"tracker"'
```

If already configured (non-null): "Tracker is already set up ({type}). Reconfigure? [y/N]"
If declined: exit.

### Step 2: Identify the tracker system

Ask: "What issue tracker does your team use?"
- GitHub Issues — reference implementation ships with the template
- Linear (via Linear MCP or API)
- Jira (via API)
- Notion (via Notion MCP)
- Other: ___

### Step 3A: GitHub Issues (fast path)

The template ships `sync-open-work.mjs.reference` — a working GitHub sync script. For GitHub, setup is mostly copying and configuring:

1. **Verify `gh` CLI is installed and authenticated:**
   ```bash
   gh auth status
   ```
   If not: guide through `gh auth login`.

2. **Identify the workspace repo.** Issues go to the workspace repo, not individual project repos. Check the workspace git remote:
   ```bash
   git -C {workspace-root} remote get-url origin
   ```
   If no remote: create one. The convention is `{org}/workspace-{project}`:
   ```bash
   gh repo create {org}/workspace-{project} --private
   git -C {workspace-root} remote add origin git@github.com:{org}/workspace-{project}.git
   git -C {workspace-root} push -u origin main
   ```

3. **Copy the reference script:**
   ```bash
   cp .claude/scripts/sync-open-work.mjs.reference .claude/scripts/sync-open-work.mjs
   chmod +x .claude/scripts/sync-open-work.mjs
   ```

4. **Create labels:**
   ```bash
   node .claude/scripts/sync-open-work.mjs --init-labels
   ```
   This creates the 6 labels the script expects: `bug`, `feat`, `chore`, `P1`, `P2`, `P3`.

5. **Create milestones.** Ask the user what milestones they want. Common patterns:
   - **Launch timeline** — `v0.1 — Alpha`, `v0.2 — Beta`, `v1.0 — Launch`, `Backlog`
   - **Simple** — just `Backlog` and `v1.0`
   - **No milestones** — skip this step
   
   For each milestone the user wants, create it:
   ```bash
   gh api repos/{owner}/{repo}/milestones -X POST -f title="v0.1 — Alpha" -f description="..." -f due_on="2026-06-30T23:59:59Z"
   ```
   
   The rule: **first whitespace-delimited token is the short form.** `"v0.1 — Alpha"` → short form `v0.1` (usable in the Milestone column). Titles can carry context (themes, dates).

6. **Choose default milestone.** Ask: "Which milestone should new tickets default to? (usually `Backlog` or leave empty)"

7. **Configure workspace.json:**
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

8. Skip to Step 7 (test the sync).

### Step 3B: Other trackers (custom path)

For Linear, Jira, Notion, or custom systems, a sync script needs to be built.

1. **Research integration approach:**
   - **Check for installed MCPs:** Read `.mcp.json` or MCP configuration
   - **Check for CLI tools:** Test if `linear`, `jira-cli`, or others are installed
   - **Search online** for MCP servers, API docs, and existing sync tools
   - Present findings: "Here's what I found for {system} integration: {options}. Recommended approach: {recommendation}."

2. **Set up access:**
   - **Linear:** API key from linear.app/settings/api, or Linear MCP setup
   - **Jira:** Instance URL, API token from id.atlassian.com, project key
   - **Notion:** Notion MCP + database ID of the target database
   - **Other:** Research online, ask the user to explain their system

3. **Build the sync script** at `.claude/scripts/sync-open-work.mjs`. Use the reference implementation (`sync-open-work.mjs.reference`) as a starting point — the parsing logic (table rows, details, tracker-state block) is tracker-agnostic. Only the external API calls differ.
   
   The script must:
   - Read and parse `shared-context/open-work.md` (same format as GitHub reference)
   - For each ticket with status ≠ `done`: create or update the external issue
   - For each ticket with status = `done`: close the external issue
   - Write `<!-- tracker-state -->` block mapping ticket IDs to external IDs
   - Persist state after every create (crash safety)
   - Support `--dry-run` and `--init-labels` (or equivalent)
   - Resolve milestones via short form → full title mapping

4. **Configure workspace.json** with the tracker config.

### Step 4: (Removed — merged into 3A/3B)

### Step 5: (Removed — merged into 3A/3B)

### Step 6: Configure workspace.json

Already handled in Step 3A or 3B.

### Step 7: Test the sync

Run the sync script and verify:
```bash
node .claude/scripts/sync-open-work.mjs --dry-run
```

If the dry run looks right:
```bash
node .claude/scripts/sync-open-work.mjs
```

Check:
- Issues were created in the external system
- The tracker-state block was added to `open-work.md`
- Labels and milestones are correct
- No errors in the output

### Step 8: Create open-work.md if needed

If `shared-context/open-work.md` doesn't exist, create it with the milestone-aware structure:

```markdown
---
state: ephemeral
lifecycle: active
type: reference
topic: open-work
updated: {today}
---

# Open Work

Source of truth for all tracked work items. Synced to {tracker target} via `.claude/scripts/sync-open-work.mjs`. Milestone column uses short form; the sync script resolves these against full milestone titles. Tickets with `—` or empty milestone fall back to the default configured in `workspace.json`.

## {repo-name}

| #  | Type  | Pri | Milestone | Status | Branch | Title |
|----|-------|-----|-----------|--------|--------|-------|
```

One table per repo in workspace.json. Ask the user if they have existing items to add.

### Step 9: Commit and report

```bash
git add .claude/scripts/sync-open-work.mjs shared-context/open-work.md workspace.json
git commit -m "feat: configure {system} issue tracker sync"
```

Report:
```
Tracker sync configured:
  System: {system}
  Script: .claude/scripts/sync-open-work.mjs
  Target: {workspace-repo}
  Default milestone: {default or "none"}

  {N} items synced

  Sync runs automatically when /complete-work finishes.
  To sync manually: node .claude/scripts/sync-open-work.mjs
  To dry-run: node .claude/scripts/sync-open-work.mjs --dry-run
```

## Notes
- For GitHub: use the reference script as-is. It handles milestones, labels, tracker-state, crash safety.
- For other trackers: the reference script's parsing logic is reusable — only the API calls differ.
- Issues go to the workspace repo, not individual project repos. This is the cross-cutting tracker model.
- One-way sync only: repo → external. open-work.md is the source of truth.
- `/complete-work` runs the sync automatically after merging.
- Milestones are created manually in the external tracker. The sync script resolves short forms to full titles, but does not create milestones.
