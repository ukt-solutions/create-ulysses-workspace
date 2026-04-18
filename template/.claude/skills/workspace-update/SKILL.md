---
name: workspace-update
description: Apply a staged template update to an initialized workspace. The CLI stages a payload in .workspace-update/; this skill processes it. Runs maintenance audit before and after.
---

# Workspace Update

Apply a staged template update to an initialized workspace. The CLI (`npx @ulysses-ai/create-workspace --upgrade`) stages the payload in `.workspace-update/`. This skill reads and applies it. Runs a maintenance audit before updating and verifies integrity after.

## Prerequisites

- `workspace.json` must have `initialized: true`
- If not initialized, report: "Workspace not initialized. Run /workspace-init first."
- `.workspace-update/` payload directory must exist (staged by `npx @ulysses-ai/create-workspace --upgrade`)
- If no `.workspace-update/` payload exists, report: "No update payload found. Run `npx @ulysses-ai/create-workspace --upgrade` to stage the template."
- Read `.workspace-update/.manifest.json` for `fromVersion`, `toVersion`, and `action`
- If `action` is `"init"`, report: "This payload is for initial setup. Run /workspace-init instead."

## Flow

### Step 1: Pre-update health check

Run `/maintenance audit` (read-only) to surface existing issues. Report findings briefly but **always continue to Step 2 immediately** — do not stop to ask about audit results. The audit is informational, not a gate. Any issues found will be included in the post-update report (Step 5) alongside the update results.

### Step 2: Compare current vs payload

For each component directory in `.workspace-update/.claude/` (skills, hooks, agents, rules, recipes), compare files against the corresponding `.claude/{component}/` directory locally:

- **New files:** present in `.workspace-update/.claude/{component}/` but not in `.claude/{component}/`
- **Updated files:** present in both but contents differ
- **Unchanged files:** present in both with identical contents
- **Removed files:** present in `.claude/{component}/` locally but not in `.workspace-update/.claude/{component}/`

Report with version info from the manifest:
```
"Template update: v{fromVersion} → v{toVersion}. {N} new files, {M} updated files, {R} removed files, {K} unchanged."
```

If everything is unchanged and there are no new or removed files, report: "Workspace is up to date (template v{toVersion}). No changes needed."

### Step 2b: Historical .gitignore safety check

Workspaces created before v0.5.1 are vulnerable to a destructive symlink bug in the old layout. The v0.8.0 layout removes the symlink entirely, so new workspaces are not vulnerable — but a workspace being upgraded from a pre-v0.8.0 version may still have the bad `.gitignore` pattern left over.

Check the workspace `.gitignore` for the `repos/` trailing-slash pattern:
```bash
grep -E '^repos/$' .gitignore
```

If found, rewrite it in place to `repos` (no trailing slash). Also check for any tracked `repos` symlink that was already committed:
```bash
git ls-files | grep -E '^repos$'
```
If found, untrack it: `git rm --cached repos`.

Commit the fix **before** applying other template updates. This runs ahead of Step 3 because applying other updates while the bug is still present could itself trigger the destruction on workspaces that still have the old layout.

### Step 3: Selective update

For each change, ask before applying:

- **New file:** "Add {file}? [Y/n]"
- **Updated file (no local mods):** "Update {file} to latest template? [Y/n]"
- **Updated file (locally modified):** "Template updated {file} but you have local changes. Show diff? [y/N]" — let user decide
- **Removed in template:** "Template removed {file}. Delete locally? [y/N]" — conservative default
- **Hook migration (.sh to .mjs):** Detect old `.sh` hooks in `.claude/hooks/` that have `.mjs` replacements in the payload. Offer: "Hook {name}.sh has a .mjs replacement in the update. Replace and update settings.json commands? [Y/n]" — this is a one-time migration for workspaces upgrading from pre-0.2.0

Also handle these non-component files from the payload:

- **settings.json:** Merge payload values into existing `.claude/settings.json` — do not overwrite user customizations. Add new keys, update hook commands if hooks were migrated, preserve user-added entries.
- **CLAUDE.md:** If `.workspace-update/CLAUDE.md.tmpl` exists, regenerate `CLAUDE.md` from the template. Preserve any user-added sections not present in the template.
- **.gitignore:** Merge new entries from the payload into the existing `.gitignore` — do not remove user-added lines.

### Step 4: Update version

Read `toVersion` from `.workspace-update/.manifest.json` and update `templateVersion` in `workspace.json` to match.

### Step 5: Post-update verification

Run `/maintenance audit` again to verify the update didn't introduce:
- Broken references (new skills not in CLAUDE.md, removed rules still referenced)
- Contradictions between updated rules and existing shared context
- Structural mismatches

Report: "Post-update verification: {N} issues found" or "Post-update verification clean."

### Step 6: Cleanup

Delete the `.workspace-update/` directory entirely. The payload has been fully processed and is no longer needed.

### Step 7: Commit

```bash
git add -A
git commit -m "chore: update workspace from template v{fromVersion} to v{toVersion}"
```

Report: "Workspace updated to v{toVersion}. Restart Claude Code if rules or hooks changed."

## Notes

- The CLI (`npx @ulysses-ai/create-workspace --upgrade`) stages the payload. This skill processes it.
- Never overwrites without asking
- Preserves local modifications and custom content
- Can be run multiple times safely (idempotent) — if `.workspace-update/` doesn't exist, it reports no payload and exits
- Initial setup is handled by `npx @ulysses-ai/create-workspace --init` + `/workspace-init` — this skill is for subsequent updates only
- The `.sh` to `.mjs` hook migration is a one-time transition for workspaces created before hooks moved to JavaScript
- The maintenance audits are read-only and non-blocking — they surface issues but don't prevent the update
