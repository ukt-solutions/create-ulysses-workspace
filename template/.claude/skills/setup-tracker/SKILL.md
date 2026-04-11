---
name: setup-tracker
description: Set up issue tracker sync for open-work.md. Identifies the tracker system, researches MCPs/APIs, builds a sync script, and configures workspace.json. Callable anytime — not just during workspace-init.
---

# Setup Tracker

Configure sync between `shared-context/open-work.md` and an external issue tracker (GitHub Issues, Linear, Jira, Notion, etc.). This skill can be run during `/workspace-init` (Steps 12-13) or standalone at any time.

## Prerequisites

- `shared-context/open-work.md` should exist. If it doesn't, create it first with the default structure (one table per repo from workspace.json).
- The open-work-tracking rule should be active (`.claude/rules/open-work-tracking.md`). If it's missing, warn: "The open-work-tracking rule is not installed. The tracker sync will work but items won't be maintained automatically."

## Flow

### Step 1: Check current state

Check if a tracker is already configured:
```bash
cat workspace.json | grep '"tracker"'
```

If already configured: "Tracker is already set up ({type}). Reconfigure? [y/N]"
If declined: exit.

### Step 2: Identify the tracker system

Ask: "What issue tracker does your team use?"
- GitHub Issues (via `gh` CLI or GitHub MCP)
- Linear (via Linear MCP or API)
- Jira (via API)
- Notion (via Notion MCP)
- Other: ___

### Step 3: Research integration approach

Based on the chosen system, research the best integration method:

1. **Check for installed MCPs:** Read `.mcp.json` or MCP configuration to see if the tracker's MCP is already available.
2. **Check for CLI tools:** Test if `gh` (GitHub), `linear` (Linear), or other CLIs are installed.
3. **Search online** for:
   - MCP servers for the chosen tracker
   - API documentation and authentication methods
   - Existing sync tools or scripts others have built
4. Present findings: "Here's what I found for {system} integration: {options}. Recommended approach: {recommendation}."

### Step 4: Set up access

Guide the user through authentication and access setup for the chosen approach:

**GitHub Issues (gh CLI):**
- Verify `gh` is installed and authenticated: `gh auth status`
- If not: guide through `gh auth login`
- Identify the org and repos from workspace.json remotes

**GitHub Issues (MCP):**
- Check if GitHub MCP is configured
- If not: guide through MCP setup

**Linear:**
- Check for Linear MCP or API key
- Guide through API key creation if needed

**Jira:**
- Need: Jira instance URL, API token, project key
- Guide through API token creation

**Notion:**
- Check if Notion MCP is configured
- Identify the database to sync to

**Other:**
- Ask the user to explain their system's API
- Research online for integration options

### Step 5: Build the sync script

Create `.claude/scripts/sync-open-work.mjs` tailored to the chosen tracker. The script should:

1. Read and parse `shared-context/open-work.md`
2. For each table (repo), for each row:
   - Check for an existing tracker marker (`<!-- gh-issue:repo#N -->` etc.)
   - If marker exists: update the existing issue (title, status, labels)
   - If no marker: create a new issue, add the marker to the row
3. For items with status `done`: close the corresponding issue
4. Handle status mapping:
   - `open` → open issue, no special label
   - `in-progress` → open issue, "in-progress" label
   - `paused` → open issue, "paused" label
   - `done` → closed issue
5. Handle priority mapping:
   - `P1` → label "priority: critical" or equivalent
   - `P2` → label "priority: important" or equivalent
   - `P3` → label "priority: nice-to-have" or equivalent
6. Report what was synced: "{N} issues created, {M} updated, {K} closed"

**For GitHub Issues specifically**, also set up an org-level GitHub Project board if the user wants one:
- `gh project create --org {org} --title "{workspace-name} Roadmap"`
- Issues are automatically pulled in from repos that are part of the project

The script should be idempotent — safe to run multiple times. It should handle errors gracefully (API rate limits, network failures, missing permissions) and report what failed.

### Step 6: Configure workspace.json

Add the tracker configuration:
```json
{
  "workspace": {
    "tracker": {
      "type": "{system}",
      "sync": ".claude/scripts/sync-open-work.mjs"
    }
  }
}
```

### Step 7: Test the sync

Run the sync script and verify:
```bash
node .claude/scripts/sync-open-work.mjs
```

Check:
- Issues were created/updated in the external system
- Markers were added to `open-work.md`
- Status and priority labels are correct
- No errors in the output

If issues are found, fix the script and re-run.

### Step 8: Create open-work.md if needed

If `shared-context/open-work.md` doesn't exist, create it now with the default structure:

```markdown
---
state: ephemeral
lifecycle: active
type: reference
topic: open-work
updated: {today}
---

# Open Work

## {repo-name}

| # | Type | Pri | Status | Branch | Title | Context |
|---|------|-----|--------|--------|-------|---------|
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
  Config: workspace.json → tracker.type = "{system}"

  {N} items synced to {system}

  Sync runs automatically when /complete-work finishes.
  To sync manually: node .claude/scripts/sync-open-work.mjs
```

## Notes
- The sync script is workspace-specific — built for the team's chosen tracker
- One-way sync only: repo → external. open-work.md is the source of truth
- `/complete-work` runs the sync automatically after merging
- The script should handle being run outside a work session (from the workspace root)
- If the tracker setup is complex, it's fine to commit partial progress and finish in a follow-up session
