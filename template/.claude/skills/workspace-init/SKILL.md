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

**Step 1: Read what's here**

Scan the workspace for existing content that needs to be organized:

```
Look for:
- CLAUDE.md.bak — the pre-migration CLAUDE.md (contains old config, rules, preferences)
- .mcp.json — external service configs (MCP servers with content to extract)
- workspace-artifacts/ — old scratch directory with files to triage
- Non-standard directories at root — anything not in the template structure
- Existing auto-memory files
- Any .md files at the workspace root
```

Report what you find: "I found {N} items that need organizing."

**Step 2: Extract rules**

If CLAUDE.md.bak or MCP sources contain rules/conventions:
- Read the content (use MCP tools if available and needed)
- For each rule or convention found:
  - Ask: "I found a rule about {topic}. Create as mandatory (.md) or optional (.md.skip)?"
  - Write to `.claude/rules/{rule-name}.md`
- If recipes exist in `.claude/recipes/`, read them for guidance on extraction

**Step 3: Create locked team knowledge**

For project context, architecture decisions, tech stack info:
- Read from CLAUDE.md.bak, MCP sources, or ask the user
- For each piece of stable knowledge:
  - Ask: "Is this still current? Should it be locked (loaded every session)?"
  - If yes: write to `shared-context/locked/{topic}.md` with proper frontmatter
  - If no: skip or write as ephemeral

Keep locked context lean — target <10KB total.

**Step 4: Create user context**

For handoffs, active work state, personal notes:
- Extract from MCP sources or CLAUDE.md.bak
- Only recent/active content — skip stale items
- Write to `shared-context/{user}/` with proper frontmatter

**Step 5: Triage non-standard content**

For each non-standard directory or file at root:
- Describe what it contains
- Ask: "Move to repos/ (project code), .claude-scratchpad/ (disposable), shared-context/ (worth keeping), or leave as-is?"
- Execute the user's decision

For workspace-artifacts/:
- List contents
- Ask about each: keep (move to scratchpad), preserve (move to shared-context), or delete

**Step 6: Clean up external dependencies**

If .mcp.json exists and content has been extracted:
- Ask: "All content extracted from {service}. Remove .mcp.json? [y/N]"
- If yes: back up to .mcp.json.bak and remove

If CLAUDE.md.bak exists and content has been extracted:
- Ask: "Remove CLAUDE.md.bak? [y/N]"

**Step 7: Set up workspace remote**

If the workspace git repo has no remote:
- Detect the org from project repo remotes (e.g., if `repos/codeapy` uses `sirmyron`, suggest `sirmyron`)
- Naming convention: `workspace-{project}` (e.g., `workspace-codeapy`)
- Ask: "Create workspace repo as `{org}/workspace-{project}`? Or provide a different name/URL."
- Create via `gh repo create {org}/{name} --private` and add as remote
- Push the initial commit

If remote already exists, skip.

**Step 8: Mark initialized**

Update workspace.json:
```json
{
  "workspace": {
    "initialized": true
  }
}
```

Commit and push:
```bash
git add -A
git commit -m "chore: workspace initialization complete"
git push origin main
```

**Step 9: Report**

"Workspace initialized:
- {N} rules created
- {M} locked context files
- {K} user context files
- {J} items triaged
- Remote: {org}/{name}

Run /start-work to begin your first work session."

## Notes
- This is a brainstorming session, not a mechanical process. Ask questions, explore the existing content, help the user decide what matters.
- Recipes in .claude/recipes/ are optional guidance — read them if relevant, but adapt to what you find.
- Don't try to extract everything — only active, relevant content. Stale is dead.
- The user knows their project better than any recipe. Follow their lead.
- One topic per file, proper frontmatter, coherent content.
