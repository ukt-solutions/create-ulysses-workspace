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
Scan all workspace-context files against each other:
- **Stale references** — file A mentions "2 mandatory rules" but there are now 4
- **Path references** — file A mentions a file that was moved or deleted
- **Contradictions** — file A says "user-scoped is default" but file B says "root is default"

### 2. Frontmatter integrity
For each workspace-context `.md` file and each `work-sessions/*/workspace/session.md`:
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

### 5. Workspace-context auto-file integrity

`workspace-context/index.md`, `workspace-context/canonical.md`, and each `workspace-context/team-member/{user}/index.md` are auto-generated from frontmatter and locked content. Run the check:

```bash
node .claude/scripts/build-workspace-context.mjs --check --root .
```

The script reports per-artifact status as JSON and uses three exit codes to distinguish what's wrong:

- `0` — all artifacts current and the rendered canonical fits inside `workspace.canonicalBudgetBytes`.
- `1` — at least one artifact is `missing` or `stale`. Run `--write` to regenerate. `missing` means the artifact does not exist yet; `stale` means it exists but no longer matches its sources (a file was added or deleted, a `description:` changed, a `shared/locked/` file was edited, an `.indexignore` rule was added).
- `2` — artifacts are current but canonical body bytes exceed the budget after the trim and stub stages have already run. Regeneration cannot fix this; the locked content itself needs triage. Stale wins over over-budget when both apply, so a `1` can hide an over-budget condition until you regen.

The JSON payload always includes a `canonical` block summarizing the budget outcome:

```json
{
  "status": "current",
  "missing": [],
  "stale": [],
  "canonical": {
    "budget": 40960,
    "current": 47802,
    "overBy": 6842,
    "selectionStatus": "stubbed",
    "trimmedFiles": ["post-release-discipline"],
    "stubbedFiles": ["project-status", "release-flow-recipes"]
  }
}
```

`selectionStatus` walks `ok` → `trimmed` → `stubbed` → `over-budget` as the script gives up progressively more reference content trying to fit the budget. `trimmedFiles` lists reference files whose `<!-- canonical:trim --> ... <!-- canonical:end-trim -->` spans were dropped; `stubbedFiles` lists reference files whose entire body was replaced with a one-line breadcrumb. `overBy` is present only when `selectionStatus === 'over-budget'` and reports the bytes still over after stubbing.

Audit mode reports the status verbatim. When `selectionStatus` is `over-budget`, audit emits the budget violation and recommends `/maintenance cleanup` to triage — regeneration will not resolve it. Cleanup mode runs `--write` when `missing` or `stale`, re-checks, and then enters the budget triage flow described in cleanup step 9 if the post-regen check still reports `over-budget`.

While the indexes are being read, also flag entries with weak fallbacks: filename-slug-only descriptions (e.g., "project status" with no period) usually indicate the underlying file is missing a `description:` or has no usable opening sentence. Suggest adding `description:` to those source files — the index will pick it up on the next regeneration.

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
- Read recent workspace-context writes (last session or last N files by updated date)
- For each, scan other workspace-context files for references that are now stale
- Surface: "{file} says X but {newer-file} now says Y. Update {file}?"
- This is the capture-time cross-check, run retroactively instead of inline

### 9. Canonical budget triage

This step runs only when the post-regen `--check` from step 8 still reports `selectionStatus: 'over-budget'`. If the regular regen pass cleared the budget — or if `--check` was already `ok`, `trimmed`, or `stubbed` after step 8 — skip this step entirely.

The rest of cleanup is suggestion-list-with-confirmation: surface a candidate, ask before applying, move on. Triage is the one meaningfully more interactive surface in `/maintenance`. It runs as a small REPL: present the budget state and a triage menu, take one action, re-run `--check`, present the menu again with the new state. No suggestion is auto-applied; every action is the user's choice.

Inputs to gather before the first menu render:

- The `canonical` block from the `--check` JSON: `budget`, `current`, `overBy`, `selectionStatus`, `trimmedFiles`, `stubbedFiles`.
- Each `workspace-context/shared/locked/*.md` file with its on-disk byte size and frontmatter `priority`.
- Per file, a list of `## Section heading` spans with byte sizes — use a simple `^## ` boundary scan, not a full markdown AST. Locked files are short and shallow enough that the naive split is sufficient; if a file ever has nested headings that confuse it, fall back to opening the file in an editor (option `[c]` below).

Render the state and present this menu:

```
Canonical budget: 40960 bytes. Current: 47802 bytes. Over by 6842 bytes.

Locked files by size:
  1. project-status.md           (priority: reference, 18432 bytes)  ← stubbed in canonical
  2. post-release-discipline.md  (priority: critical, 12104 bytes)
  3. naming-conventions.md       (priority: critical,  4218 bytes)
  4. cross-platform.md           (priority: critical,   702 bytes)
  5. product-bias-risk.md        (priority: critical,  1346 bytes)

Largest sections in priority:critical files (eligible for promotion to reference or trim markers):
  - project-status.md > "What's Built" (5120 bytes)
  - post-release-discipline.md > "Backstop: branch protection" (3892 bytes)
  - post-release-discipline.md > "Why" (2104 bytes)

Triage (one at a time):
  [a] Demote a file from critical to reference
  [b] Add canonical:trim markers around a specific section
  [c] Open a locked file in the editor for manual edits
  [d] Skip — accept the over-budget warning
  [q] Done
```

For each chosen action:

- **`[a]` Demote.** Ask which file. Rewrite its frontmatter `priority: critical` → `priority: reference`. No body changes. Re-run `--check`, re-render the menu with the new state.
- **`[b]` Add trim markers.** Ask which `file > section`. Wrap the section by inserting `<!-- canonical:trim -->` on its own line just before the section heading and `<!-- canonical:end-trim -->` on its own line just after the section's last line (the line before the next `^## ` heading or EOF). Re-run `--check`, re-render.
- **`[c]` Open in editor.** Print the file path and pause. The user edits manually, returns, and confirms — then re-run `--check` and re-render.
- **`[d]` Skip.** Accept the over-budget state for this run; record the acknowledgement in the run summary. Audit will continue to surface the warning on subsequent runs.
- **`[q]` Done.** Exit triage. Report the final `--check` status as the run result.

Trim markers and demotions only matter for `priority: reference` files — `<!-- canonical:trim -->` spans on a `priority: critical` file are inert until the file is demoted. The triage flow never auto-decides which file to demote or which section to wrap; it surfaces the data, presents options, and waits.

### 10. Health metrics
- Canonical budget — read from the same `--check` invocation as step 5. Reported as `current / budget` bytes with the selection status (e.g., `full`, `2 reference files trimmed`). Over-budget cases are deferred to the cleanup triage flow rather than re-reported here.
- Number of ephemeral files — flag if accumulating without resolution
- Session log stats (if `workspace-scratchpad/session-log.jsonl` exists):
  - Sessions without capture
  - Average session length
  - Compaction-to-capture ratio

## Output Format

```
/maintenance results:

Issues (3):
  ✗ workspace-context/team-member/alice/old-handoff.md references branch feature/old
    but that branch was deleted
  ✗ 2 inflight files exist but no active work session (orphaned?)
  ✗ Canonical exceeds budget: 47 KB / 40 KB. 2 reference files were stubbed;
    canonical is still 6.8 KB over. Run /maintenance cleanup to triage.

Warnings (2):
  ⚠ workspace-context/team-member/alice/workspace-analytics.md not updated in 8 days
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
  ✓ Canonical: 17 KB / 40 KB (full)
  ✓ Template is up to date (v0.14.0)
```

## Flow

1. Scan workspace-context/ recursively — read all `.md` files and their frontmatter
2. Read CLAUDE.md — extract skill and rule references
3. Read workspace.json — extract repo manifest
4. Check `.claude/rules/`, `.claude/skills/`, `.claude/agents/` against references
5. Check git state (worktrees, branches, remotes)
6. Run `node .claude/scripts/build-workspace-context.mjs --check --root .` — capture status. Exit `0` = clean and within budget, `1` = artifact missing or stale, `2` = artifacts current but canonical body over budget. The `canonical` block in the JSON output drives both the audit budget line and the cleanup triage decision.
7. Read session-log.jsonl if it exists
8. If cleanup mode: regenerate the workspace-context auto-files if stale (index.md, canonical.md, per-user team-member indexes); compare files pairwise for overlap; scan for stale cross-references. If post-regen `--check` reports `over-budget`, enter the canonical-budget triage flow described in cleanup step 9.
9. Compile and present findings grouped by severity

## Notes
- Audit mode is always read-only — never modifies files
- Cleanup mode asks before acting on any suggestion
- Run before /release to catch drift before it compounds
- Run after long gaps between sessions to surface stale context
- Consider running at the start of each work session
