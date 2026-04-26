---
name: maintenance
description: Workspace maintenance — audit integrity, clean up stale context, suggest merges. Run periodically or before /release.
---

# Maintenance

Keep the workspace healthy. Combines integrity auditing with active cleanup recommendations.

## Parameters
- `/maintenance` — full run (audit + cleanup)
- `/maintenance audit` — integrity checks only (read-only)
- `/maintenance cleanup` — stale context, suggested merges, reconciliation only

## Audit

Read-only integrity checks. Reports problems but never modifies files.

### 1. Cross-reference consistency
Scan all shared-context files against each other:
- **Stale references** — file A mentions "2 mandatory rules" but there are now 4
- **Path references** — file A mentions a file that was moved or deleted
- **Contradictions** — file A says "user-scoped is default" but file B says "root is default"

### 2. Frontmatter integrity
For each shared-context `.md` file and each `work-sessions/*/workspace/session.md`:
- Valid frontmatter? (state, lifecycle, type, topic, author, updated; plus name/status/branch/repos for session trackers)
- `branch` field references a branch that still exists?
- `repo`/`repos` field references repos that exist in workspace.json?
- `lifecycle: active` on a file not updated in 7+ days? (stale candidate)
- `lifecycle: resolved` files that should have been processed by /complete-work?
- Session tracker `status: active` but the workspace worktree at `work-sessions/{name}/workspace/` is missing? (orphaned)
- `confidence` field present? Must be one of `high`, `medium`, `low` if set.

### 3. Workspace structure
- Actual directory layout matches what workspace-structure rule describes?
- CLAUDE.md references skills and rules that actually exist?
- Orphaned rules or skills not referenced anywhere?
- workspace.json repos all present in `repos/`?

### 4. Git state
- Worktrees with no recent commits? (orphaned)
- Local branches with no remote tracking? (unpushed work)
- Worktrees whose branch has already been merged? (cleanup candidates)
- Workspace repo on expected branch?
- Orphan worktree records in project repos — run `git -C repos/{repo} worktree list` for each repo and flag any `prunable` markers. These usually come from a workspace-first teardown (the unsafe order) leaving stale admin records behind. Suggest `git worktree prune` on the affected repo.

### 5. Shared-context index integrity

`shared-context/index.md` is auto-generated from frontmatter. Run the check:

```bash
node .claude/scripts/build-shared-context-index.mjs --check --root .
```

Three failure modes (script exits 1 with a JSON status):

- `missing` — `shared-context/` exists but `index.md` does not. Run `--write` to create.
- `stale` — `index.md` exists but its entries no longer match the filesystem. Causes: a file was added or deleted, a `description:` was changed, a `.indexignore` rule was added. Run `--write` to regenerate.
- (no failure) — `current` with the entry count.

Audit mode reports the status. Cleanup mode runs `--write` if stale or missing, then re-checks.

While the index is being read, also flag entries with weak fallbacks: filename-slug-only descriptions (e.g., "project status" with no period) usually indicate the underlying file is missing a `description:` or has no usable opening sentence. Suggest adding `description:` to those source files — the index will pick it up on the next regeneration.

### 6. Template freshness

Compare the workspace's pinned template version against the latest published on npm.

Always invoke `refreshIfStale` from the audit (regardless of `workspace.versionCheck.ambient` — the user explicitly ran `/maintenance`):

```javascript
import { refreshIfStale } from './.claude/lib/freshness.mjs';
const result = await refreshIfStale({
  workspaceRoot: process.cwd(),
  ttlMs: 24 * 60 * 60 * 1000,
});
```

Report one of:
- `outdated` → `✗ Template v{current} → v{latest} available. Run npx @ulysses-ai/create-workspace --upgrade.`
- `current` → `✓ Template is up to date (v{latest}).`
- `unknown` (with cache) → `⚠ Could not reach npm registry; last cached latest was v{latest} as of {checkedAt}.`
- `unknown` (no cache) → `⚠ Could not reach npm registry; no cached version on file. Try again when online.`
- `skipped: 'uninitialized'` → `⚠ Workspace not initialized; freshness check unavailable.`

## Cleanup

Active recommendations. Flags problems and suggests fixes, but asks before acting.

### 7. Stale context
- Ephemeral files not updated in 7+ days — suggest resolve, update, or archive
- `work-sessions/{name}/` folders whose worktrees are gone — suggest cleanup
- Session trackers whose branches have been merged — suggest `/complete-work` post-flight cleanup
- Braindumps that overlap significantly — suggest merging (e.g., "workspace-branching.md and persistent-work-sessions.md cover the same topic")
- Handoffs referencing deleted branches — suggest resolve or remove

### 8. Context reconciliation
- Read recent shared-context writes (last session or last N files by updated date)
- For each, scan other shared-context files for references that are now stale
- Surface: "{file} says X but {newer-file} now says Y. Update {file}?"
- This is the capture-time cross-check, run retroactively instead of inline

### 9. Health metrics
- Size of `shared-context/locked/` relative to the active model's context window — flag if over 5% (yellow) or 15% (red). Absolute byte count is a weak proxy; contradictions, stale references, and duplicated coverage across files matter more than total size.
- Number of ephemeral files — flag if accumulating without resolution
- Session log stats (if `workspace-scratchpad/session-log.jsonl` exists):
  - Sessions without capture
  - Average session length
  - Compaction-to-capture ratio

## Output Format

```
/maintenance results:

Issues (3):
  ✗ shared-context/alice/old-handoff.md references branch feature/old
    but that branch was deleted
  ✗ 2 inflight files exist but no active work session (orphaned?)
  ✗ Locked context is 18% of model context window (red threshold: 15%)

Warnings (2):
  ⚠ shared-context/alice/workspace-analytics.md not updated in 8 days
  ⚠ Worktree work-sessions/old-feature/workspace has no commits in 5 days

Cleanup suggestions (2):
  ⊕ workspace-branching.md and persistent-work-sessions.md overlap
    significantly — merge into one?
  ⊕ migration-recipes.md still says "/sync handles dogfood" but
    /sync was replaced by /sync-work — update?

OK (5):
  ✓ All CLAUDE.md skill references valid
  ✓ Workspace structure matches rule
  ✓ workspace.json repos all present
  ✓ No frontmatter errors
  ✓ Template is up to date (v0.14.0)
```

## Flow

1. Scan shared-context/ recursively — read all `.md` files and their frontmatter
2. Read CLAUDE.md — extract skill and rule references
3. Read workspace.json — extract repo manifest
4. Check `.claude/rules/`, `.claude/skills/`, `.claude/agents/` against references
5. Check git state (worktrees, branches, remotes)
6. Run `node .claude/scripts/build-shared-context-index.mjs --check --root .` — capture status
7. Read session-log.jsonl if it exists
8. If cleanup mode: regenerate the shared-context index if stale; compare files pairwise for overlap; scan for stale cross-references
9. Compile and present findings grouped by severity

## Notes
- Audit mode is always read-only — never modifies files
- Cleanup mode asks before acting on any suggestion
- Run before /release to catch drift before it compounds
- Run after long gaps between sessions to surface stale context
- Consider running at the start of each work session
