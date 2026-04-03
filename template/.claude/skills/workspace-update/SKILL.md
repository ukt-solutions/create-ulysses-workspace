---
name: workspace-update
description: Check for and apply template updates to an initialized workspace. Runs maintenance audit before and after. Use when the template version has changed or periodically to keep the workspace current.
---

# Workspace Update

Apply template updates to an initialized workspace. Runs a maintenance audit before updating and verifies integrity after.

## Prerequisites

- `workspace.json` must have `initialized: true`
- If not initialized, report: "Workspace not initialized. Run /workspace-init first."

## Flow

### Step 1: Pre-update health check

Run `/maintenance audit` (read-only) to surface existing issues before applying changes. If critical issues are found (broken references, contradictions), report them and ask whether to proceed or fix first.

### Step 2: Compare current vs template

For each template component (skills, agents, rules, hooks):
- Check if the local version matches the template version
- Identify new files in the template that don't exist locally
- Identify local modifications (files that differ from template)
- Compare `templateVersion` in workspace.json against the latest available

Report:
```
"Template update: v{current} → v{latest}. {N} new files, {M} updated files, {K} locally modified."
```

If everything is current, report: "Workspace is up to date (template v{version}). No changes needed."

### Step 3: Selective update

For each change, ask before applying:

- **New file:** "Add {file}? [Y/n]"
- **Updated file (no local mods):** "Update {file} to latest template? [Y/n]"
- **Updated file (locally modified):** "Template updated {file} but you have local changes. Show diff? [y/N]" — let user decide
- **Removed in template:** "Template removed {file}. Delete locally? [y/N]" — conservative default

### Step 4: Update version

Update `templateVersion` in workspace.json to the new version.

### Step 5: Post-update verification

Run `/maintenance audit` again to verify the update didn't introduce:
- Broken references (new skills not in CLAUDE.md, removed rules still referenced)
- Contradictions between updated rules and existing shared context
- Structural mismatches

Report: "Post-update verification: {N} issues found" or "Post-update verification clean."

### Step 6: Commit

```bash
git add -A
git commit -m "chore: update workspace from template v{old} to v{new}"
```

## Notes

- Never overwrites without asking
- Preserves local modifications and custom content
- Can be run multiple times safely (idempotent)
- Initial migration is handled by `npx create-claude-workspace --migrate` + `/workspace-init` — this skill is for subsequent updates only
- The maintenance audits are read-only and non-blocking — they surface issues but don't prevent the update
