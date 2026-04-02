---
name: migrate
description: Convert an existing workspace to the claude-workspace template, or update from a newer template version. Interactive — asks what to migrate.
---

# Migrate

Convert an existing workspace to the claude-workspace convention, or update an existing claude-workspace from a newer template version.

## Parameters
- `/migrate` — detect current state and offer migration options
- `/migrate update` — check for template updates and apply selectively

## Flow: Initial Migration

**Step 1: Detect existing structure**
Scan the workspace root for:
- `CLAUDE.md` — does it exist? What format?
- `.claude/` — rules, settings, skills, agents, hooks?
- `repos/` — any project repos already cloned?
- `shared-context/` — does it exist?
- `workspace.json` — does it exist?
- Any other directories that might map to template conventions (e.g., `workspace-artifacts/`, `handoffs/`, `docs/`)

**Step 2: Report findings**
"Found existing workspace with: {list of what exists}. Missing: {list of what's missing}."

**Step 3: Interactive migration**
For each missing component, ask whether to set it up:

- "Create `workspace.json` with repo manifest? [Y/n]" → ask for repos if yes
- "Set up `shared-context/` with locked/ and user directories? [Y/n]"
- "Add `.claude/hooks/` (SessionStart, SubagentStart, PreCompact, PostCompact)? [Y/n]"
- "Add `.claude/skills/` (10 workspace skills)? [Y/n]"
- "Add `.claude/agents/` (researcher, implementer, reviewer)? [Y/n]"
- "Add `.claude/rules/` (4 mandatory, 4+ optional)? [Y/n]"
- "Update `.gitignore` with workspace conventions? [Y/n]"
- "Set up `.claude-scratchpad/` for disposable files? [Y/n]"

**Step 4: Migrate existing content**
If existing context files are found (e.g., `workspace-artifacts/`, old handoff files):
- "Found files in `{dir}`. Move to `shared-context/{user}/`? [y/N]"
- For each file: ask if it should be ephemeral, locked, or local-only

If existing rules are found in non-standard locations:
- "Found rules in `{location}`. Copy to `.claude/rules/`? [Y/n]"

**Step 5: Configure user identity**
If `.claude/settings.local.json` doesn't exist:
- Ask for user name (for context scoping)
- Write settings.local.json

**Step 6: Update CLAUDE.md**
If CLAUDE.md exists but doesn't match the template format:
- Show the diff between current and template CLAUDE.md
- "Update CLAUDE.md to template format? [Y/n]"
- Preserve any custom content the user added

**Step 7: Commit**
```bash
git add -A
git commit -m "chore: migrate workspace to claude-workspace template"
```

## Flow: Template Update

**Step 1: Compare current vs template**
For each template component (skills, agents, rules, hooks):
- Check if the local version matches the template version
- Identify new files in the template that don't exist locally
- Identify local modifications (files that differ from template)

**Step 2: Report**
"Template update available. {N} new files, {M} updated files, {K} locally modified."

**Step 3: Selective update**
For each change:
- **New file:** "Add {file}? [Y/n]"
- **Updated file (no local mods):** "Update {file} to latest template? [Y/n]"
- **Updated file (locally modified):** "Template updated {file} but you have local changes. Show diff? [y/N]" → let user decide

**Step 4: Commit**
```bash
git add -A
git commit -m "chore: update workspace from template v{version}"
```

## Notes
- Never overwrites without asking
- Preserves local modifications and custom content
- Can be run multiple times safely (idempotent detection)
- Also available as `npx create-claude-workspace --migrate` for workspaces without the skill installed yet
