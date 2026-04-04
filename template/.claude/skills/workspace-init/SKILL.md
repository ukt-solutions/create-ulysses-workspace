---
name: workspace-init
description: One-time workspace initialization session. Guides you through populating shared context, rules, and team knowledge from existing content. Run after migration.
---

# Workspace Init

Guided initialization session for a newly migrated or scaffolded workspace. Reads template components from the `.workspace-update/` payload directory (staged by `npx create-claude-workspace --init`), installs them with user approval, populates shared context, creates locked team knowledge, and cleans up.

This skill runs once. After completion, it sets `workspace.initialized: true` in workspace.json.

## Prerequisites

- `.workspace-update/` payload directory must exist (staged by `npx create-claude-workspace --init`)
- If no `.workspace-update/` payload exists, report: "No update payload found. Run `npx create-claude-workspace --init` to stage the template."
- `workspace.json` must exist with `initialized: false` (or field missing)

## Gate

If `workspace.json` has `"initialized": true` AND `.workspace-update/` exists with `"action": "init"` in `.workspace-update/.manifest.json`, warn: "Workspace is already initialized. Did you mean to run `npx create-claude-workspace --upgrade` instead?" Do not proceed unless the user explicitly confirms they want to re-initialize.

If `workspace.json` has `"initialized": true` and no `.workspace-update/` payload exists, report: "Workspace already initialized. Use /workspace-update for template updates, or /maintenance to check integrity."

## Branching

Workspace-init creates a branch for all its work:
```bash
git checkout -b chore/workspace-init
```
All commits go on this branch. After completion, the user reviews and squash-merges to main. This allows easy replay, adjustment via interactive rebase, or reverting individual changes.

## Flow

### Step 1: Inventory

Scan the workspace for existing content that needs organizing:
- CLAUDE.md.bak — pre-migration CLAUDE.md (old config, rules, preferences)
- .mcp.json or .mcp.json.bak — external service configs (MCP servers with content to extract)
- Non-standard directories and files at root — ANYTHING not part of the template structure, including gitignored items
- Existing auto-memory files
- Any files at workspace root that aren't: CLAUDE.md, workspace.json, .gitignore

Present the inventory as a table.

### Step 2: Identify documentation sources

Before presenting the plan, ask the user explicitly:

"Where does your project documentation live? (Select all that apply)"
- Notion pages (will need MCP access to extract)
- Confluence / wiki
- Markdown files in the repo
- Google Docs
- Other: ___
- No external documentation

This determines whether documentation extraction is part of the plan and sets expectations for what access is needed. If external sources are identified, confirm they're accessible before including extraction in the plan.

### Step 3: Present the plan

Based on inventory and documentation sources, formulate a numbered plan. Present it to the user before executing anything:

```
"Here's what I found and my proposed plan:

Step 1: ✓ Inventory (done — {N} items found)
Step 2: ✓ Documentation sources identified
Step 3: ✓ Plan (this step)
Step 4: Install template components from payload
Step 5: Extract content from documentation sources
Step 6: Preserve local preferences from CLAUDE.md.bak
Step 7: Create locked team knowledge
Step 8: Clean root directory — move everything non-template to unmigrated
Step 9: Clean up payload and pre-migration artifacts
Step 10: Verify — self-contradiction check
Step 11: Set up workspace remote
Step 12: Mark initialized, report

Adjust this plan, reorder, skip steps, or add things?"
```

Adapt the plan to what was actually found. Only include relevant steps. Wait for user confirmation before proceeding.

### Step 4: Install template components from payload

Read `.workspace-update/.manifest.json` to confirm this is an `"action": "init"` payload.

Install components from `.workspace-update/.claude/` to their final locations in `.claude/`. For each component directory — skills, hooks, agents, rules, recipes:

1. List files in `.workspace-update/.claude/{component}/`
2. For each file:
   - If the file does not exist locally in `.claude/{component}/`: "Install {file}? [Y/n]"
   - If the file exists locally and differs from the payload version: "Template has {file} but you have a local version. Show diff? [y/N]" — let the user decide whether to overwrite, keep theirs, or merge
   - If the file exists locally and matches: skip silently

For hooks specifically: note that all hooks are Node.js (.mjs) files and require Node.js runtime. The bootstrap hook (`workspace-update-check.mjs` and `_utils.mjs`) was already installed by the CLI — confirm it matches the payload version and update if needed.

Also install these top-level files from the payload:

- **`.claude/settings.json`** — Read from `.workspace-update/.claude/settings.json`. If `.claude/settings.json` already exists locally, merge the payload settings into the existing file (preserve any user-added settings, add missing entries from the payload). Never overwrite the entire file.
- **`.gitignore`** — Read from `.workspace-update/_gitignore`. If `.gitignore` already exists locally, merge: add any lines from the payload that aren't already present. Preserve all existing entries.
- **`CLAUDE.md`** — Read from `.workspace-update/CLAUDE.md.tmpl`. This replaces the bootstrap CLAUDE.md. Substitute `{{workspace_name}}` (or similar template variables) with the workspace name from `workspace.json`. If the existing CLAUDE.md has user-added content beyond the bootstrap template, preserve it.

**Commit:** `git commit -m "feat: install template components from payload"`

### Step 5: Extract content from documentation sources

For each documentation source identified in Step 2:
- Check .claude/recipes/ for relevant migration recipes
- Attempt to access the source (MCP tools, file reads, etc.)
- **Track access failures** — if a source is unreachable, note it but don't stop. Continue with other sources.
- For rules/conventions found: write to `.claude/rules/{rule-name}.md`
- For project context/decisions: stage for Step 7 (locked knowledge)
- For handoffs/active work: write to `shared-context/{user}/` as ephemeral

**Commit:** `git commit -m "feat: extract rules and context from documentation sources"`

### Step 6: Preserve local preferences

Read CLAUDE.md.bak for non-documentation content worth keeping:
- Local coding conventions → `.claude/rules/` (new rule files)
- Project-specific notes → `shared-context/locked/` or `shared-context/{user}/`
- Repo paths → verify they match workspace.json

**Commit:** `git commit -m "feat: preserve local preferences as rules and context"`

### Step 7: Create locked team knowledge

Combine content from Step 5, Step 6, and existing auto-memory into locked context:
- For each piece of stable knowledge: write to `shared-context/locked/{topic}.md`
- Keep locked context lean — target <10KB total
- One topic per file, proper frontmatter
- Only lock what the team needs every session. Everything else is ephemeral.

**Commit:** `git commit -m "feat: create locked team knowledge"`

### Step 8: Clean root directory

The workspace root should contain ONLY template structure: CLAUDE.md, workspace.json, .gitignore, and the standard directories (.claude/, shared-context/, repos/, .claude-scratchpad/).

**Aggressively move everything else to `.claude-scratchpad/unmigrated/`** — including gitignored items. The root must be clean.

```bash
mkdir -p .claude-scratchpad/unmigrated
```

For each non-template item at root:
- Move to `.claude-scratchpad/unmigrated/{name}`
- This includes: workspace-artifacts/, old directories, stray files, MCP data directories, IDE configs that leaked into root

Report explicitly: "Moved {N} items to .claude-scratchpad/unmigrated/: {list}. Review these and promote anything worth keeping."

Nothing should be silently ignored. If it exists, it gets triaged or moved here. Audit .gitignore for entries that only exist to suppress pre-migration content — move those items to unmigrated and remove the entries. The gitignore should only contain template-standard patterns, not workarounds for leftover files.

**Commit:** `git commit -m "chore: clean root — move non-template items to unmigrated"`

### Step 9: Clean up payload and pre-migration artifacts

After content has been extracted and template components installed:
- **Delete `.workspace-update/` directory entirely** — the payload has been fully consumed
- **Remove any `@.workspace-update/` lines from CLAUDE.md** — these were temporary bootstrap imports that pointed at the payload; the rules are now installed in `.claude/rules/`
- .mcp.json → back up to .mcp.json.bak if not already, move both to unmigrated
- CLAUDE.md.bak → remove (content extracted)
- Any other pre-migration artifacts → clean up or move to unmigrated

**Commit:** `git commit -m "chore: clean up payload and pre-migration artifacts"`

### Step 10: Verify — self-contradiction check

Read EVERY created and activated file. This is mandatory and must be thorough:

**Files to check:**
- Every `.claude/rules/*.md` (not .skip)
- Every `shared-context/locked/*.md`
- Every `shared-context/{user}/*.md`

**Check for:**
- References to removed services (MCP servers, APIs that were just deleted or backed up)
- References to removed files (CLAUDE.md.bak, .mcp.json, old paths, moved directories)
- References to `.workspace-update/` (should be gone — all payload references must be cleaned up)
- References to external sources as if they're still the primary source of truth (e.g., "Use the Notion MCP tools" after Notion MCP was removed)
- Contradictions between rules (one says X, another says not-X)
- Stale template preamble text left in activated rules (e.g., "Activate this rule if...")
- Provenance notes that could mislead ("Extracted from Notion doc 06" — fine as attribution, but should not imply Notion is still authoritative)

Fix ALL issues found. This step must not be rushed.

**Commit:** `git commit -m "fix: resolve self-contradictions from init"`

### Step 11: Set up workspace remote

If the workspace git repo has no remote:
- Detect the org from project repo remotes in workspace.json
- Naming convention: `workspace-{project}` (e.g., `workspace-codeapy`)
- Ask: "Create workspace repo as `{org}/workspace-{project}`? Or provide a different name/URL."
- Create via `gh repo create {org}/{name} --private` and add as remote
- Do NOT push yet — user merges the branch first

### Step 12: Mark initialized and report

Update workspace.json:
- Set `initialized: true`
- Set `templateVersion` to the version from `.workspace-update/.manifest.json` (read this before the payload was deleted in Step 9 — if not already captured, check the commit history or the manifest value noted during Step 4)

**Commit:** `git commit -m "chore: mark workspace as initialized"`

**Final report must include ALL of the following:**

```
"Workspace initialized. Restart Claude Code for all rules and hooks to take effect. Then run /start-work to begin.

Branch: chore/workspace-init

Summary:
- {N} rules created/activated
- {P} template components installed (skills, hooks, agents, recipes)
- {M} locked context files ({size}KB / 10KB target)
- {K} user context files
- {L} items moved to .claude-scratchpad/unmigrated/
- {V} self-contradictions found and fixed
- Template version: {version}
- Remote: {org}/{name} (ready to push after merge)

Issues encountered:
- {list every expected behavior that failed — documentation sources that were
  unreachable, MCP pages that returned errors, files that couldn't be read,
  permissions issues, anything that didn't work as planned}

If no issues: "No issues encountered."

Items in .claude-scratchpad/unmigrated/:
- {list each item with a one-line description}

Review the branch:
  git log --oneline chore/workspace-init
  git diff main..chore/workspace-init

Then merge:
  git checkout main
  git merge --squash chore/workspace-init
  git commit -m 'chore: workspace initialization'
  git push origin main

This session is done. Start a fresh Claude Code session and say 'Hi' —
the init is complete, no hook will fire. Then run /start-work to begin."
```

## Execution Rules

- Present the plan upfront. Don't ask permission at every micro-step.
- Execute confidently. Report after each major step completes.
- Commit after each major step — granular history on the branch.
- Ask the user only for decisions that require judgment (what to keep, where to put things).
- **Capture the `templateVersion` from `.manifest.json` early** (during Step 4) before the payload is deleted in Step 9. You'll need it for Step 12.
- **Root directory cleanliness is non-negotiable.** If something isn't part of the template structure, it goes to unmigrated. Don't leave items because they're gitignored — move them.
- **Every expected behavior that fails must be reported.** If the plan said "extract from Notion" and Notion returned 404, that's an issue to report — not silently skip.
- **Don't suggest starting work at the end.** Tell the user to restart Claude Code and then run /start-work in a fresh session. Init is its own session.
- The verification step (Step 10) is mandatory — read every file, check thoroughly. Don't rush it.
- Recipes in .claude/recipes/ are guidance, not scripts. Adapt to what you find.
- The user knows their project. Follow their lead on content decisions.

## Notes
- One topic per file, proper frontmatter, coherent content
- Don't extract everything — only active, relevant content. Stale is dead.
- Keep locked context under 10KB — it's loaded every session
- The branch allows the user to review, adjust, or redo individual steps before merging
- Documentation sources are first-class — always ask, always confirm access, always report failures
