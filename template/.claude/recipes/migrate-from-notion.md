# Recipe: Migrate from Notion

Migrate rules, memory, and handoffs from Notion pages into the claude-workspace template structure.

## Prerequisites

- The workspace must have a working Notion MCP server configured in `.mcp.json`
- Run this recipe BEFORE removing the MCP server
- The migration tool (`npx create-claude-workspace --migrate`) should have already been run to install the template structure

## Detection

This recipe applies when:
- `.mcp.json` contains a Notion MCP server configuration
- `CLAUDE.md` (or `.bak`) references Notion page IDs for rules, memory, or handoffs

## Steps

### 1. Identify Notion pages

Read `CLAUDE.md.bak` (the pre-migration backup) to find Notion page references:
- Look for page IDs (32-character hex strings)
- Note the purpose of each page (rules, memory/context, handoffs)

### 2. Extract rules

For each Notion page that contains rules/conventions:

```
Fetch the page content using the Notion MCP server.
For each rule or convention section:
  - Create a .claude/rules/{rule-name}.md file
  - Use the section heading as the filename (kebab-case)
  - If the rule is project-specific, make it mandatory (.md)
  - If the rule is optional, use .md.skip
  - Write the content as a coherent rule following the template format:
    # Rule Name
    {What the rule says}
    ## Why
    {Rationale if provided}
```

### 3. Extract memory and context

For each Notion page that contains project memory, context, or key decisions:

```
Fetch the page content using the Notion MCP server.
Determine scope:
  - Architecture decisions, tech stack, stable conventions → shared-context/locked/
  - Active project state, current priorities → shared-context/{user}/
  - Historical context no longer relevant → skip

For each section:
  - Create a shared-context file with proper frontmatter:
    ---
    state: locked (or ephemeral)
    lifecycle: active
    type: promoted
    topic: {section-topic}
    author: {user}
    updated: {today}
    ---
  - Write content adapted for the template format
  - One topic per file — split large Notion pages into multiple files
```

### 4. Extract handoffs

For each Notion page that contains session handoffs or context transfers:

```
Fetch the page content using the Notion MCP server.
For recent/active handoffs only (skip stale ones):
  - Create shared-context/{user}/{handoff-name}.md
  - Use handoff frontmatter format with type: handoff
  - Extract: status, key decisions, next steps, open questions
  - Set lifecycle: active (or paused if the work is suspended)
```

### 5. Preserve local preferences

Check `CLAUDE.md.bak` for local preferences that aren't Notion-dependent:
- Repo paths, coding conventions, project-specific notes
- Add these to appropriate places:
  - Coding conventions → `.claude/rules/` (new rule file)
  - Project notes → `shared-context/locked/` or `shared-context/{user}/`
  - Repo paths → already in `workspace.json`

### 6. Remove Notion dependency

After all content is extracted and verified:

```bash
# Back up and remove MCP config
mv .mcp.json .mcp.json.bak

# Remove CLAUDE.md backup (original Notion-fetching version)
rm CLAUDE.md.bak
```

Verify the workspace works without Notion:
- Start a new Claude Code session
- Confirm SessionStart hook surfaces the migrated context
- Confirm rules are loaded (check /context)
- Confirm skills work

### 7. Commit

```bash
git add .claude/rules/ shared-context/
git commit -m "chore: migrate Notion content to local files"
```

## Notes

- Don't try to migrate everything — only active, relevant content
- Stale Notion handoffs can be skipped. If it's more than a few weeks old and not referenced, it's dead.
- Large Notion pages should be split into multiple focused files (one topic per file)
- The migration is one-way — once verified, the Notion pages become the archive, not the source of truth
