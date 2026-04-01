---
name: release
description: Combine unreleased branch notes into a versioned release document and synthesize ephemeral shared context into locked entries. Use at release time.
---

# Release

Combine unreleased branch-release-notes into a versioned document and synthesize ephemeral context into locked team knowledge.

## Parameters
- `/release {version}` — create release notes for a specific version
- `/release` — ask for the version

## Flow

**Step 1: Determine version and repo**
If no version parameter: ask "What version is this release? (e.g., 1.2.0)"
If multiple repos in workspace: ask which repo to release.

**Step 2: Read unreleased notes**
```bash
ls repos/{repo}/release-notes/unreleased/
```
Read all `branch-release-notes-*.md` and `branch-release-questions-*.md` files.

If no unreleased files exist: "No unreleased notes found. Nothing to release."

**Step 3: Group and organize**
Group notes by type using `type:` frontmatter (feature, fix, chore):
- Features first, then fixes, then chores
- Within each group, order chronologically by date

**Step 4: Handle questions**
Present all open questions from `branch-release-questions-*.md` files:
- "These questions are still open from development. For each one:"
  - Answer it (provide the answer, remove from questions)
  - Defer it (keep in a "Known Issues" section of the release notes)
  - Discard it (no longer relevant)

**Step 5: Synthesize release document**
Write `repos/{repo}/release-notes/v{version}.md`:
```markdown
# v{version} Release Notes

**Date:** {YYYY-MM-DD}

## Features
{Coherent narrative combining all feature branch-release-notes.
Deduplicate related items. Credit authors. Don't just concatenate — weave into readable prose.}

## Fixes
{Same treatment for bugfix branches.}

## Maintenance
{Same for chore branches.}

## Known Issues
{Deferred questions from Step 4, if any.}

## Contributors
{List of unique authors from all branch notes.}
```

**Step 6: Archive unreleased files**
```bash
mkdir -p repos/{repo}/release-notes/archive/v{version}
mv repos/{repo}/release-notes/unreleased/branch-release-* repos/{repo}/release-notes/archive/v{version}/
```

**Step 7: Commit release notes**
```bash
cd repos/{repo}
git add release-notes/
git commit -m "docs: v{version} release notes"
```

**Step 8: Synthesize shared context**
Process ephemeral shared-context entries:
1. List all ephemeral entries with `lifecycle: resolved`
2. For each, determine:
   - Does an existing locked entry cover this topic? Merge into it (enrich)
   - Are there related resolved entries? Combine into a new locked entry
   - Is it stale/fully consumed by release notes? Archive or delete
3. For merged/new locked entries:
   - Set `state: locked`, `type: synthesized`
   - Move to `shared-context/locked/`
   - Write concise, focused content — team truths, not session history
4. Commit:
   ```bash
   git add shared-context/
   git commit -m "release: synthesize shared context for v{version}"
   ```

**Step 9: Report**
"Release v{version} complete. {N} branch notes combined. {M} context entries synthesized into {K} locked entries."

## Notes
- Release notes live in the PROJECT repo
- Context synthesis happens in the WORKSPACE repo
- Both get separate commits
- The archive directory preserves the raw branch notes for audit
