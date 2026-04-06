---
name: workspace-init
description: First-time workspace initialization. Clones repos, installs template components, extracts team knowledge from documentation sources, activates rules, configures user identity. Run once after scaffolding with --init.
---

# Workspace Init

Guided initialization for a newly scaffolded workspace. Clones repos, installs template components from the `.workspace-update/` payload, extracts team knowledge from documentation sources, populates shared context, and configures the workspace for use.

This skill runs once. After completion, it sets `workspace.initialized: true` in workspace.json.

## Prerequisites

- `.workspace-update/` payload directory must exist (staged by `npx create-claude-workspace --init`)
- If no `.workspace-update/` payload exists, report: "No update payload found. Run `npx create-claude-workspace --init` to stage the template."
- `workspace.json` must exist

## Gate

If `workspace.json` has `"initialized": true` AND `.workspace-update/` exists with `"action": "init"` in `.workspace-update/.manifest.json`, warn: "Workspace is already initialized. Did you mean to run `npx create-claude-workspace --upgrade` instead?" Do not proceed unless the user explicitly confirms they want to re-initialize.

If `workspace.json` has `"initialized": true` and no `.workspace-update/` payload exists, report: "Workspace already initialized. Use /workspace-update for template updates, or /maintenance to check integrity."

## Branching

Workspace-init creates a branch for all its work:
```bash
git checkout -b chore/workspace-init
```
All commits go on this branch. After completion, the user reviews and squash-merges to main.

## Flow

### Step 1: Inventory

Scan the workspace for existing content that needs organizing:
- CLAUDE.md.bak — pre-existing CLAUDE.md (old config, rules, preferences)
- .mcp.json or .mcp.json.bak — external service configs
- Non-standard directories and files at root — anything not part of the template structure
- Existing auto-memory files
- Any files at workspace root that aren't: CLAUDE.md, workspace.json, .gitignore

Present the inventory as a table.

### Step 2: Read workspace.json and clone repos

Read `workspace.json` and list the configured repos.

For each repo in `workspace.json`:
- Check if `repos/{name}` already exists
- If missing: ask "Clone {name} from {remote}? [Y/n]"
- If confirmed: `git clone {remote} repos/{name}`
- If exists: report "repos/{name} already present"

### Step 3: Identify documentation sources

Ask the user:

"Where does your project documentation live? (Select all that apply)"
- Notion pages (will need MCP access to extract)
- Confluence / wiki
- Markdown files in the repo
- Google Docs
- Other: ___
- No external documentation

This determines whether documentation extraction is part of the plan.

### Step 4: Present the plan

Based on inventory, repos, and documentation sources, formulate a numbered plan. Present it before executing:

```
"Here's what I found and my proposed plan:

Step 1: ✓ Inventory (done — {N} items found)
Step 2: ✓ Repos cloned
Step 3: ✓ Documentation sources identified
Step 4: ✓ Plan (this step)
Step 5: Install template components from payload
Step 6: Activate optional rules
Step 7: Extract content from documentation sources
Step 8: Preserve local preferences from CLAUDE.md.bak
Step 9: Create locked team knowledge
Step 10: Configure user identity
Step 11: Clean root directory
Step 12: Clean up payload and pre-migration artifacts
Step 13: Verify — self-contradiction check
Step 14: Set up workspace remote
Step 15: Mark initialized, report

Adjust this plan, reorder, skip steps, or add things?"
```

Adapt the plan to what was actually found. Only include relevant steps. Wait for user confirmation.

### Step 5: Install template components from payload

Read `.workspace-update/.manifest.json` to confirm this is an `"action": "init"` payload. **Capture the `templateVersion` now** — you'll need it for Step 15 after the payload is deleted.

Install components from `.workspace-update/.claude/` to `.claude/`. For each component directory — skills, hooks, agents, rules, scripts:

1. List files in `.workspace-update/.claude/{component}/`
2. For each file:
   - If the file does not exist locally: "Install {file}? [Y/n]"
   - If the file exists locally and differs: "Template has {file} but you have a local version. Show diff? [y/N]" — let the user decide
   - If the file exists locally and matches: skip silently

Also install these top-level files from the payload:
- **`.claude/settings.json`** — Merge payload settings into existing file. Preserve user-added settings, add missing entries.
- **`.gitignore`** — Merge: add lines from payload not already present.
- **`CLAUDE.md`** — Generate from `.workspace-update/CLAUDE.md.tmpl`, substituting `{{project-name}}` with the workspace name. If the existing CLAUDE.md has user-added content beyond the bootstrap template, preserve it.

**Commit:** `git commit -m "feat: install template components from payload"`

### Step 6: Activate optional rules

List all `.md.skip` files in `.claude/rules/`:
- For each: ask "Activate {rule-name}? {brief description} [y/N]"
- If yes: rename `{name}.md.skip` to `{name}.md`
- If no: leave as-is

**Commit (if any activated):** `git commit -m "feat: activate selected optional rules"`

### Step 7: Extract content from documentation sources

For each documentation source identified in Step 3:
- Check .claude/recipes/ for relevant migration recipes
- Attempt to access the source (MCP tools, file reads, etc.)
- **Track access failures** — if a source is unreachable, note it but don't stop
- For rules/conventions found: write to `.claude/rules/{rule-name}.md`
- For project context/decisions: stage for Step 9 (locked knowledge)
- For handoffs/active work: write to `shared-context/{user}/` as ephemeral

**Commit:** `git commit -m "feat: extract rules and context from documentation sources"`

### Step 8: Preserve local preferences

Read CLAUDE.md.bak for non-documentation content worth keeping:
- Local coding conventions → `.claude/rules/` (new rule files)
- Project-specific notes → `shared-context/locked/` or `shared-context/{user}/`
- Repo paths → verify they match workspace.json

**Commit:** `git commit -m "feat: preserve local preferences as rules and context"`

### Step 9: Create locked team knowledge

Combine content from Steps 7, 8, and existing auto-memory into locked context:
- For each piece of stable knowledge: write to `shared-context/locked/{topic}.md`
- Keep locked context lean — target <10KB total
- One topic per file, proper frontmatter
- Only lock what the team needs every session. Everything else is ephemeral.

**Commit:** `git commit -m "feat: create locked team knowledge"`

### Step 10: Configure user identity

Ask: "What name should be used for your user-scoped context? [{system-username}]"
Save to `.claude/settings.local.json`:
```json
{
  "workspace": {
    "user": "{name}"
  }
}
```

### Step 11: Clean root directory

The workspace root should contain ONLY template structure: CLAUDE.md, workspace.json, .gitignore, and the standard directories (.claude/, shared-context/, repos/, .claude-scratchpad/).

Move everything else to `.claude-scratchpad/unmigrated/`:

```bash
mkdir -p .claude-scratchpad/unmigrated
```

For each non-template item at root:
- Move to `.claude-scratchpad/unmigrated/{name}`
- This includes old directories, stray files, MCP data directories, IDE configs

Report: "Moved {N} items to .claude-scratchpad/unmigrated/: {list}."

**Commit:** `git commit -m "chore: clean root — move non-template items to unmigrated"`

### Step 12: Clean up payload and pre-migration artifacts

- **Delete `.workspace-update/` directory entirely**
- **Remove any `@.workspace-update/` lines from CLAUDE.md**
- .mcp.json → back up and move to unmigrated
- CLAUDE.md.bak → remove (content extracted)
- Any other pre-migration artifacts → clean up or move to unmigrated

**Commit:** `git commit -m "chore: clean up payload and pre-migration artifacts"`

### Step 13: Verify — self-contradiction check

Read EVERY created and activated file:
- Every `.claude/rules/*.md` (not .skip)
- Every `shared-context/locked/*.md`
- Every `shared-context/{user}/*.md`

Check for:
- References to removed services or files
- References to `.workspace-update/` (should be gone)
- Contradictions between rules
- Stale template preamble text
- References to external sources as if still authoritative after migration

Fix ALL issues found. This step must not be rushed.

**Commit:** `git commit -m "fix: resolve self-contradictions from init"`

### Step 14: Set up workspace remote

If the workspace git repo has no remote:
- Detect the org from project repo remotes in workspace.json
- Ask: "Create workspace repo as `{org}/workspace-{project}`? Or provide a different name/URL."
- Create via `gh repo create {org}/{name} --private` and add as remote
- Do NOT push yet — user merges the branch first

### Step 15: Mark initialized and report

Update workspace.json:
- Set `initialized: true`
- Set `templateVersion` to the version captured from `.manifest.json` in Step 5

**Commit:** `git commit -m "chore: mark workspace as initialized"`

**Final report:**

```
"Workspace initialized. Restart Claude Code for all rules and hooks to take effect. Then run /start-work to begin.

Branch: chore/workspace-init

Summary:
- {N} repos cloned
- {R} rules created/activated
- {P} template components installed
- {M} locked context files ({size}KB / 10KB target)
- {K} user context files
- {L} items moved to .claude-scratchpad/unmigrated/
- {V} self-contradictions found and fixed
- Template version: {version}
- Remote: {org}/{name} (ready to push after merge)

Issues encountered:
- {list every expected behavior that failed}

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

This session is done. Start a fresh Claude Code session and run /start-work to begin."
```

## Execution Rules

- Present the plan upfront. Don't ask permission at every micro-step.
- Execute confidently. Report after each major step completes.
- Commit after each major step — granular history on the branch.
- Ask the user only for decisions that require judgment.
- **Capture the `templateVersion` from `.manifest.json` early** (Step 5) before the payload is deleted in Step 12.
- **Root directory cleanliness is non-negotiable.** Non-template items go to unmigrated.
- **Every expected behavior that fails must be reported.**
- **Don't suggest starting work at the end.** Tell the user to restart Claude Code and run /start-work in a fresh session.
- The verification step (Step 13) is mandatory — read every file, check thoroughly.
- This skill is idempotent — safe to run if interrupted and restarted.

## Notes
- One topic per file, proper frontmatter, coherent content
- Keep locked context under 10KB
- The branch allows the user to review, adjust, or redo individual steps before merging
- Documentation sources are first-class — always ask, always confirm access, always report failures
