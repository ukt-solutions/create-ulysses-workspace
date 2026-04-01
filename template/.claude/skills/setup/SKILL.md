---
name: setup
description: First-time workspace initialization. Use when setting up a new workspace or onboarding a new team member. Clones repos, activates rules, configures user identity.
---

# Workspace Setup

Interactive first-time setup for this claude-workspace.

## Flow

**Step 1: Read workspace.json**
Read `workspace.json` from the workspace root. List the configured repos and their remotes.

**Step 2: Clone repos**
For each repo in `workspace.json`:
- Check if `repos/{name}` already exists
- If missing: ask "Clone {name} from {remote}? [Y/n]"
- If confirmed: `git clone {remote} repos/{name}`
- If exists: report "repos/{name} already present"

Also check `settings.local.json` for `workspace.localRepos` and offer to clone those too.

**Step 3: Activate optional rules**
List all `.md.skip` files in `.claude/rules/`:
- For each: ask "Activate {rule-name}? [y/N]"
- If yes: rename `{name}.md.skip` to `{name}.md`
- If no: leave as-is

**Step 4: User identity**
Ask: "What name should be used for your user-scoped context? [{system-username}]"
Save to `.claude/settings.local.json`:
```json
{
  "workspace": {
    "user": "{name}"
  }
}
```

**Step 5: Confirm**
Report: "Workspace ready. {N} repos cloned, {M} rules active. Run /start-work to begin."

## Notes
- This skill is idempotent — safe to run multiple times
- It never overwrites existing repos or settings
- For teams: the team lead sets up workspace.json and commits it, then each member runs /setup
