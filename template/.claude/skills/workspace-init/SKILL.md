---
name: workspace-init
description: One-time workspace initialization session. Guides you through populating shared context, rules, and team knowledge from existing content. Run after migration.
---

# Workspace Init

Guided initialization session for a newly migrated or scaffolded workspace. Populates shared context, creates locked team knowledge, and cleans up pre-template content.

This skill runs once. After completion, it sets `workspace.initialized: true` in workspace.json.

## Prerequisites

- Template structure must be installed (via `npx create-claude-workspace` or `--migrate`)
- `workspace.json` must exist with `initialized: false` (or field missing)

## Gate

If `workspace.json` has `"initialized": true`, report: "Workspace already initialized. Use /migrate --update for template updates, or /audit to check integrity."

## Flow

### Step 1: Inventory

Scan the workspace for existing content that needs organizing:
- CLAUDE.md.bak — pre-migration CLAUDE.md (old config, rules, preferences)
- .mcp.json — external service configs (MCP servers with content to extract)
- workspace-artifacts/ — old scratch directory
- Non-standard directories at root
- Existing auto-memory files
- Any files at workspace root that aren't part of the template

Present the inventory as a table. Then immediately present the full plan:

### Step 2: Present the plan

Based on the inventory, formulate a numbered plan covering ALL steps. Present it to the user before executing anything:

```
"Here's what I found and my proposed plan:

Step 1: ✓ Inventory (done — {N} items found)
Step 2: ✓ Plan (this step)
Step 3: Extract content from Notion/MCP (if .mcp.json found)
   - Fetch rules page → create .claude/rules/ files
   - Fetch memory/context page → create shared-context/locked/ files
   - Fetch handoffs page → create shared-context/{user}/ files
Step 4: Preserve local preferences from CLAUDE.md.bak
Step 5: Create locked team knowledge (from extracted content + auto-memory)
Step 6: Triage non-standard content ({list of dirs/files})
Step 7: Clean up external dependencies (.mcp.json, CLAUDE.md.bak)
Step 8: Set up workspace remote
Step 9: Mark initialized and commit

Adjust this plan, reorder, skip steps, or add things?"
```

Adapt the plan to what was actually found. If there's no MCP to extract from, skip that step. If there are no non-standard dirs, skip triage. Only include steps that are relevant.

Wait for user confirmation before proceeding. Execute steps in order, reporting progress after each.

### Step 3: Extract content from external sources

If .mcp.json exists with MCP servers that hold content (Notion, etc.):
- Check .claude/recipes/ for relevant migration recipes — read them for guidance
- Use the MCP tools to fetch content from each source
- For rules/conventions found: write to `.claude/rules/{rule-name}.md`
- For project context/decisions: stage for Step 5 (locked knowledge)
- For handoffs/active work: write to `shared-context/{user}/` as ephemeral

If no MCP or no content to extract, skip.

### Step 4: Preserve local preferences

Read CLAUDE.md.bak for non-MCP content worth keeping:
- Local coding conventions → `.claude/rules/` (new rule files)
- Project-specific notes → `shared-context/locked/` or `shared-context/{user}/`
- Repo paths → verify they match workspace.json

### Step 5: Create locked team knowledge

Combine content from Step 3, Step 4, and existing auto-memory into locked context:
- For each piece of stable knowledge: write to `shared-context/locked/{topic}.md`
- Keep locked context lean — target <10KB total
- One topic per file, proper frontmatter
- Only lock what the team needs every session. Everything else is ephemeral.

### Step 6: Triage non-standard content

For each non-standard directory or file at root:
- Describe what it contains
- Decide: move to repos/ (project code), .claude-scratchpad/ (disposable), shared-context/ (worth keeping), delete, or leave as-is
- Execute

### Step 7: Clean up external dependencies

After content has been extracted:
- .mcp.json → back up to .mcp.json.bak and remove
- CLAUDE.md.bak → remove (content extracted)
- Any other pre-migration artifacts → clean up

### Step 8: Set up workspace remote

If the workspace git repo has no remote:
- Detect the org from project repo remotes in workspace.json
- Naming convention: `workspace-{project}` (e.g., `workspace-codeapy`)
- Suggest: "Create workspace repo as `{org}/workspace-{project}`?"
- Create via `gh repo create {org}/{name} --private` and add as remote
- Push

### Step 9: Mark initialized

Update workspace.json: set `initialized: true`

Commit and push:
```bash
git add -A
git commit -m "chore: workspace initialization complete"
git push origin main
```

Report:
```
"Workspace initialized:
- {N} rules created
- {M} locked context files
- {K} user context files
- {J} items triaged
- Remote: {org}/{name}

Run /start-work to begin your first work session."
```

## Execution Style

- Present the plan upfront. Don't ask permission at every micro-step.
- Execute confidently. Report after each major step completes.
- Ask the user only for decisions that require judgment (what to keep, where to put things).
- If something is clearly disposable (empty dirs, stale logs), just clean it up and report.
- Recipes in .claude/recipes/ are guidance, not scripts. Adapt to what you find.
- The user knows their project. Follow their lead on content decisions.

## Notes
- One topic per file, proper frontmatter, coherent content
- Don't extract everything — only active, relevant content. Stale is dead.
- Keep locked context under 10KB — it's loaded every session
