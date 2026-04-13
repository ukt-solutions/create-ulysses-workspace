---
name: workspace-init
description: First-time workspace initialization. Clones repos, installs template components, extracts team knowledge from documentation sources and Claude chat history, activates rules, configures user identity. Run once after scaffolding with --init.
---

# Workspace Init

Guided initialization for a newly scaffolded workspace. Clones repos, installs template components from the `.workspace-update/` payload, extracts team knowledge from documentation sources and prior Claude chat history, populates shared context, formalizes existing worktrees as work sessions, and configures the workspace for use.

This skill runs once. After completion, it sets `workspace.initialized: true` in workspace.json.

## Prerequisites

- `.workspace-update/` payload directory must exist (staged by `npx create-ulysses-workspace --init`)
- If no `.workspace-update/` payload exists, report: "No update payload found. Run `npx create-ulysses-workspace --init` to stage the template."
- `workspace.json` must exist

## Gate

If `workspace.json` has `"initialized": true` AND `.workspace-update/` exists with `"action": "init"` in `.workspace-update/.manifest.json`, warn: "Workspace is already initialized. Did you mean to run `npx create-ulysses-workspace --upgrade` instead?" Do not proceed unless the user explicitly confirms they want to re-initialize.

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
- Existing auto-memory files in `~/.claude/projects/` for this project path
- Existing git worktrees (branches checked out in separate directories)
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
- Claude chat history from prior sessions on this project
- Other: ___
- No external documentation

This determines whether documentation extraction is part of the plan.

**Important:** If the user indicates a source, ask: "Has any content already been extracted from this source? (e.g., rules or context files already pulled down from Notion)" Check `shared-context/` and `.claude/rules/` for files that appear to contain extracted content. If content already exists from a source, mark it as "already extracted" and skip re-fetching unless the user explicitly wants a refresh.

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
Step 8: Scan Claude chat history
Step 9: Preserve local preferences from CLAUDE.md.bak
Step 10: Create locked team knowledge
Step 11: Formalize existing worktrees as work sessions
Step 12: Populate open-work.md from discovered items
Step 13: Set up issue tracker sync
Step 14: Configure user identity
Step 15: Clean root directory
Step 16: Clean up payload and pre-migration artifacts
Step 17: Verify — self-contradiction check
Step 18: Set up workspace remote
Step 19: Mark initialized, report

Adjust this plan, reorder, skip steps, or add things?"
```

Adapt the plan to what was actually found. Only include relevant steps. Wait for user confirmation.

### Step 5: Install template components from payload

Read `.workspace-update/.manifest.json` to confirm this is an `"action": "init"` payload. **Capture the `templateVersion` now** — you'll need it for Step 19 after the payload is deleted.

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

**Before fetching from any source, check if content was already extracted:**
- Scan `shared-context/` and `.claude/rules/` for files that reference the source (e.g., files mentioning Notion page IDs, Confluence URLs, etc.)
- If found: "Content from {source} appears to already be in {files}. Skip re-fetching? [Y/n]"
- If the user confirms skip: move on to the next source
- If the user wants a refresh: proceed with extraction but note which files will be updated

For sources that need extraction:
- Check .claude/recipes/ for relevant migration recipes
- Attempt to access the source (MCP tools, file reads, etc.)
- **Track access failures** — if a source is unreachable, note it but don't stop
- For rules/conventions found: write to `.claude/rules/{rule-name}.md`
- For project context/decisions: stage for Step 10 (locked knowledge)
- For handoffs/active work: write to `shared-context/{user}/` as ephemeral

**Commit:** `git commit -m "feat: extract rules and context from documentation sources"`

### Step 8: Scan Claude chat history

Search for prior Claude Code conversation logs related to this project. Chat history lives in `~/.claude/projects/` organized by project path.

**Discovery:**
1. Identify the project path(s) that map to this workspace — check the current directory path and any known previous paths (from CLAUDE.md.bak or workspace config)
2. List available conversation logs:
   ```bash
   ls -la ~/.claude/projects/{project-path}/
   ```
3. Read conversation metadata to identify relevant sessions

**Build a processing manifest** before reading any content. Auto-compaction could happen at any point during this step, so the manifest ensures progress survives:

Write `.claude-scratchpad/chat-history-manifest.json`:
```json
{
  "projectPaths": ["{path1}", "{path2}"],
  "sessions": [
    { "id": "{session-id}", "path": "{file-path}", "status": "pending" },
    ...
  ],
  "synthesized": []
}
```

**Process each session:**
1. Read the session log
2. Extract: key decisions made, architectural choices, patterns established, unresolved questions, work in progress at the time
3. Update the manifest entry status to "processed"
4. Synthesize findings into shared context:
   - Decisions and architecture → stage for locked context (Step 10)
   - Work-in-progress context → `shared-context/{user}/` as ephemeral handoffs
   - Patterns and conventions → candidate rules for `.claude/rules/`

Present a summary: "Found {N} prior sessions. Extracted {M} decisions, {K} handoffs, {P} convention candidates."

Let the user review and approve what gets kept.

**Commit:** `git commit -m "feat: synthesize context from Claude chat history"`

Remove the manifest after processing:
```bash
rm -f .claude-scratchpad/chat-history-manifest.json
```

### Step 9: Preserve local preferences

Read CLAUDE.md.bak for non-documentation content worth keeping:
- Local coding conventions → `.claude/rules/` (new rule files)
- Project-specific notes → `shared-context/locked/` or `shared-context/{user}/`
- Repo paths → verify they match workspace.json

**Commit:** `git commit -m "feat: preserve local preferences as rules and context"`

### Step 10: Create locked team knowledge

Combine content from Steps 7, 8, 9, and existing auto-memory into locked context:
- For each piece of stable knowledge: write to `shared-context/locked/{topic}.md`
- Keep locked context lean — target <10KB total
- One topic per file, proper frontmatter
- Only lock what the team needs every session. Everything else is ephemeral.

**Commit:** `git commit -m "feat: create locked team knowledge"`

### Step 11: Formalize existing worktrees as work sessions

Check for existing git worktrees that represent in-progress work:

```bash
# For each repo in workspace.json:
git -C repos/{repo} worktree list
```

Also check for feature/bugfix/chore branches that are checked out in directories outside `repos/`:
```bash
# Check for directories that look like worktrees
ls -d repos/*___wt-* 2>/dev/null
# Also check for non-standard worktree locations
git -C repos/{repo} branch -v
```

For each active worktree found:
1. Determine the session name from the branch name or directory name
2. Ask: "Found worktree for branch `{branch}` at `{path}`. Formalize as work session '{suggested-name}'? [Y/n]"
3. If confirmed:
   - Create a session marker in `.claude-scratchpad/`:
     ```json
     {
       "name": "{session-name}",
       "description": "{description from user or inferred from branch}",
       "branch": "{branch}",
       "repos": ["{repo}"],
       "status": "active",
       "created": "{now}",
       "user": "{user}",
       "chatSessions": []
     }
     ```
   - Create workspace worktree if it doesn't exist: `repos/{session-name}___wt-workspace/`
   - Rename/move project worktree to match convention if needed: `repos/{session-name}___wt-{repo}/`
   - Create inflight tracker at `shared-context/{user}/inflight/session-{session-name}.md`
   - **Search Claude chat history for sessions that touched this branch** — scan conversation logs for commits or file edits on this branch, and synthesize what was being worked on into the inflight tracker
   - Ask the user to describe the current state and next steps, add to tracker

4. If declined: leave the worktree as-is, report it in the final summary

**Commit:** `git commit -m "feat: formalize existing worktrees as work sessions"`

### Step 12: Populate open-work.md

Create `shared-context/open-work.md` with one table per repo from workspace.json. Populate it from all sources discovered during init:

1. **From braindumps and handoffs** (Steps 7-9): scan extracted content for action items, bugs, feature requests, TODOs. Each becomes a work item.
2. **From formalized worktrees** (Step 11): each in-progress session becomes a work item with status `in-progress` and its branch populated.
3. **From Claude chat history** (Step 8): unresolved questions, noted bugs, planned features mentioned in conversations.
4. **From the user**: "Any other work items to add? Bugs you know about, features planned?"

Present the populated table for review before committing. Let the user adjust priorities, remove items, or add more.

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

**Commit:** `git commit -m "feat: populate open-work.md from discovered items"`

### Step 13: Set up issue tracker sync

Ask: "Do you use an issue tracker for this project? (GitHub Issues, Linear, Jira, Notion, or none)"

**If none:** Skip. open-work.md is the only tracker.

**If yes:** Run `/setup-tracker` — it handles the full tracker configuration flow (identify system, research integration, set up access, build sync script, configure workspace.json, test). That skill can also be run standalone anytime after init.

If the tracker setup is complex or requires access the user doesn't have right now, note it as a follow-up item in open-work.md itself and move on — the user can run `/setup-tracker` later.

### Step 14: Configure user identity

Ask: "What name should be used for your user-scoped context? [{system-username}]"
Save to `.claude/settings.local.json`:
```json
{
  "workspace": {
    "user": "{name}"
  }
}
```

### Step 15: Clean root directory

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

### Step 16: Clean up payload and pre-migration artifacts

- **Delete `.workspace-update/` directory entirely**
- **Remove any `@.workspace-update/` lines from CLAUDE.md**
- .mcp.json → back up and move to unmigrated
- CLAUDE.md.bak → remove (content extracted)
- Any other pre-migration artifacts → clean up or move to unmigrated

**Commit:** `git commit -m "chore: clean up payload and pre-migration artifacts"`

### Step 17: Verify — self-contradiction check

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

### Step 18: Set up workspace remote

Check if the workspace git repo already has a remote:
```bash
git remote -v
```

**If a remote already exists:** Report "Remote already configured: {url}" and skip to the next step.

**If no remote but a team workspace repo already exists** (e.g., a teammate already initialized and pushed):
- Ask: "Does a workspace repo already exist that you want to connect to? Provide the URL, or say 'create new'."
- If URL provided:
  ```bash
  git remote add origin {url}
  git fetch origin
  ```
  Then rebase the init branch onto the remote's main:
  ```bash
  git rebase origin/main
  ```
  If conflicts arise (e.g., shared-context differs between your init and what's already committed), STOP and present them. These are legitimate merge decisions — your extracted content vs what your teammate committed. Help the user resolve each conflict:
  - For shared-context files: the remote version likely has the teammate's extractions. Merge both perspectives or keep the more complete version.
  - For rules: if both sides activated different optional rules, keep both.
  - For CLAUDE.md: use the remote version (it's the established one), add any local customizations the user wants.

**If no remote and creating new:**
- Detect the org from project repo remotes in workspace.json
- Ask: "Create workspace repo as `{org}/workspace-{project}`? Or provide a different name/URL."
- Create via `gh repo create {org}/{name} --private` and add as remote
- Do NOT push yet — user merges the branch first

### Step 19: Mark initialized and report

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
- {H} prior chat sessions scanned, {D} decisions extracted
- {W} existing worktrees formalized as work sessions
- {L} items moved to .claude-scratchpad/unmigrated/
- {V} self-contradictions found and fixed
- Template version: {version}
- Remote: {status}

Issues encountered:
- {list every expected behavior that failed}

If no issues: "No issues encountered."

Active work sessions (formalized from existing worktrees):
- {list each with branch, repo, and description}

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
- **Capture the `templateVersion` from `.manifest.json` early** (Step 5) before the payload is deleted in Step 16.
- **Root directory cleanliness is non-negotiable.** Non-template items go to unmigrated.
- **Every expected behavior that fails must be reported.**
- **Don't suggest starting work at the end.** Tell the user to restart Claude Code and run /start-work in a fresh session.
- The verification step (Step 17) is mandatory — read every file, check thoroughly.
- **Build manifests before long operations.** Chat history scanning (Step 8) and worktree formalization (Step 11) can be interrupted by auto-compaction. Write a manifest to `.claude-scratchpad/` before starting so progress survives.
- **Never re-fetch content that already exists.** Always check shared-context and rules for existing extractions before accessing external sources.
- This skill is idempotent — safe to run if interrupted and restarted.

## Notes
- One topic per file, proper frontmatter, coherent content
- Keep locked context under 10KB
- The branch allows the user to review, adjust, or redo individual steps before merging
- Documentation sources are first-class — always ask, always confirm access, always report failures
- Chat history scanning uses a manifest to survive auto-compaction
- Existing worktrees are formalized with session markers, trackers, and linked chat history
