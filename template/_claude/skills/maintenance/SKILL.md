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
- Task-model state (gh:146), three checks:
  - **Unrecorded task worktrees** — list `repos/*/.claude/worktrees/*` and `.claude/worktrees/*`, read each candidate's branch (`git -C "{path}" rev-parse --abbrev-ref HEAD`), and keep only those on a task-prefixed branch (`feature/`, `bugfix/`, `chore/`) — Claude Code's own worktrees carry other branch names, so the prefix filter skips them without guessing a name convention. Cross-reference the chat records (`node .claude/scripts/chat-record.mjs --root . --list`): a task-prefixed worktree no record entry claims is *unrecorded* — it may be a legitimate no-tracker task (those are never recorded), so present it and ask before suggesting `node .claude/scripts/task-worktree.mjs --root . --remove --repo "{repo}" --branch "{branch}"`.
  - **Stale record entries** — a record task entry whose worktree is gone (neither `repos/{repo}/.claude/worktrees/{slug}/` nor, for `repo: "."`, `.claude/worktrees/{slug}/` exists). Suggest `node .claude/scripts/chat-record.mjs --root . --remove-task --chat "{chat}" --work-item "{workItem}" --repo "{repo}"` (omit `--repo` when the entry has none).
  - **Merged but never completed** — a recorded task branch that already merged. Judge merged-ness by the forge's merged PRs for that repo, matching on head branch — never `git branch --merged`, which a squash merge (never an ancestor) silently misses. `/complete-work` never ran. Suggest running `/complete-work` for that branch (detection from the chat record finds it).

### 5. Workspace-context auto-file integrity

`workspace-context/index.md`, `workspace-context/canonical.md`, and each `workspace-context/team-member/{user}/index.md` are auto-generated from frontmatter and locked content. Run the check:

```bash
node .claude/scripts/build-workspace-context.mjs --check --root .
```

The script reports per-artifact status as JSON and uses three exit codes to distinguish what's wrong:

- `0` — all artifacts current and, when a canonical budget is set, the rendered canonical fits inside `workspace.canonicalBudgetBytes`.
- `1` — at least one artifact is `missing` or `stale`. Run `--write` to regenerate. `missing` means the artifact does not exist yet; `stale` means it exists but no longer matches its sources (a file was added or deleted, a `description:` changed, a `shared/locked/` file was edited, an `.indexignore` rule was added).
- `2` — artifacts are current but canonical body bytes exceed the budget after the trim and stub stages have already run. Only reachable when a budget is set. Regeneration cannot fix this; the locked content itself needs triage. Stale wins over over-budget when both apply, so a `1` can hide an over-budget condition until you regen.

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

The canonical budget is opt-in. `workspace.canonicalBudgetBytes` is off unless workspace.json sets it — absent or `null` means no budget. When off, `canonical.md` ships every locked file in full, the `canonical` block reports `"budget": null` with `selectionStatus: "ok"`, exit `2` cannot occur, and the audit reports one informational line in place of the budget OK/warning line:

```
• Canonical budget: off (alwaysLoadedBudgetBytes covers the total)
```

No warning accompanies it. To turn the budget back on, set a byte count in workspace.json (e.g. `"canonicalBudgetBytes": 40960`) and regenerate.

Audit mode reports the status verbatim. When a budget is set and `selectionStatus` is `over-budget`, audit emits the budget violation and recommends `/maintenance cleanup` to triage — regeneration will not resolve it. Cleanup mode runs `--write` when `missing` or `stale`, re-checks, and then enters the budget triage flow described in cleanup step 11 if the post-regen check still reports `over-budget`.

While the indexes are being read, also flag entries with weak fallbacks: filename-slug-only descriptions (e.g., "project status" with no period) usually indicate the underlying file is missing a `description:` or has no usable opening sentence. Suggest adding `description:` to those source files — the index will pick it up on the next regeneration.

### 6. Always-loaded context budget

Everything Claude reads at launch — CLAUDE.md, its @-imports, and the active rules — is measured against `workspace.alwaysLoadedBudgetBytes`:

```bash
node .claude/scripts/context-footprint.mjs --root .
```

Rules carrying `paths:` frontmatter are conditional (they load only when a matching file is touched); the script lists them in a separate conditional section and excludes them from the total. With no `alwaysLoadedBudgetBytes` in workspace.json there is no budget and this check passes trivially.

Within budget → an OK line: `✓ Always-loaded context: 43 KB / 64 KB`. Over budget → a Warning (the workspace still functions; this is drift, not breakage) naming the top contributors and the fixes:

```
⚠ Always-loaded context exceeds budget: 78 KB / 64 KB. Top contributors:
  .claude/rules/git-conventions.md (12 KB), CLAUDE.md (9 KB),
  .claude/rules/workspace-structure.md (8 KB). Scope situational rules with
  paths: frontmatter, or move reference content to shared/.
```

The script itself exits `1` when over budget; `/maintenance` reports that as the warning above, not as a failed run.

### 7. Template freshness

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

### 8. Component age check

Scan the following file sets for a YAML frontmatter `updated:` field:
- `.claude/rules/*.md` (active rules only — `.md.skip` files are included too, since the rule content can still drift)
- `.claude/skills/*/SKILL.md`
- `.claude/agents/*.md`
- `.claude/hooks/*.mjs`

For each file that has an `updated:` field, compute the age in days from today. If the age exceeds 180 days, flag the file as a stale component candidate. Print the file name, the `updated:` date, and the age in days so the contributor knows how far the file has drifted.

Files without an `updated:` field are skipped — the check is opt-in and activates the discipline incrementally as contributors add frontmatter to the files they own. To start tracking a file, add `updated: <today>` to its frontmatter; the check will surface it if it goes stale.

When stale candidates are found, surface them as warnings in the output format and link to `config-review.md.skip` (in `.claude/rules/`) as the opt-in rule that documents the review cadence and rationale.

### 9. Stale context
- Ephemeral files not updated in 7+ days — suggest resolve, update, or archive
- `work-sessions/{name}/` folders whose worktrees are gone — suggest cleanup
- Session trackers whose branches have been merged — suggest `/complete-work` post-flight cleanup
- Unrecorded task-prefixed worktrees (no chat-record entry claims them; may be no-tracker tasks) — ask, then suggest `task-worktree.mjs --remove`
- Chat-record task entries whose worktree is gone — suggest `chat-record.mjs --remove-task`
- Recorded task branches already merged (per the forge's merged PRs, not `git branch --merged`) — suggest `/complete-work`
- Braindumps that overlap significantly — suggest merging (e.g., "workspace-branching.md and persistent-work-sessions.md cover the same topic")
- Handoffs referencing deleted branches — suggest resolve or remove

### 10. Context reconciliation
- Read recent workspace-context writes (last session or last N files by updated date)
- For each, scan other workspace-context files for references that are now stale
- Surface: "{file} says X but {newer-file} now says Y. Update {file}?"
- This is the capture-time cross-check, run retroactively instead of inline

### 11. Canonical budget triage

This step runs only when a canonical budget is set (`workspace.canonicalBudgetBytes` holds a number) and the post-regen `--check` from the cleanup regen pass (Flow step 9) still reports `selectionStatus: 'over-budget'`. With the budget off — absent or `null` in workspace.json — `--check` can never report over-budget, so this step is unreachable. Skip it too if the regular regen pass cleared the budget, or if `--check` was already `ok`, `trimmed`, or `stubbed` after that pass.

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

### 12. Forge configuration

Read `workspace.json`. If `workspace.tracker?.type === 'github-issues'` and `workspace.forge` is unset, emit a notice (not an error):

```
ℹ workspace.json has tracker.type='github-issues' but no workspace.forge field.
  Skills default to GitHub forge operations; add `"forge": {"type": "github"}`
  to workspace.json to make the choice explicit. See .claude/rules/forge-operations.md.
```

This is migration guidance for workspaces created before the `forge` field landed — the field is back-compat with a sensible default, so the unset case is not a bug, just an opportunity to make the implicit explicit. If `workspace.forge.type` is set to a value with no adapter at `.claude/scripts/forges/{type}.mjs`, that IS an error and goes in the Issues section.

### 13. Health metrics
- Canonical budget — read from the same `--check` invocation as step 5. When a budget is set, reported as `current / budget` bytes with the selection status (e.g., `full`, `2 reference files trimmed`); over-budget cases are deferred to the cleanup triage flow rather than re-reported here. When off, report the step 5 one-liner: `• Canonical budget: off (alwaysLoadedBudgetBytes covers the total)`.
- Always-loaded context — read from the same `context-footprint.mjs` invocation as audit step 6, reported the same way (`current / budget` bytes); over-budget is already surfaced as a warning there.
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

OK (6):
  ✓ All CLAUDE.md skill references valid
  ✓ Workspace structure matches rule
  ✓ workspace.json repos all present
  ✓ Canonical: 17 KB / 40 KB (full)
  ✓ Always-loaded context: 43 KB / 64 KB
  ✓ Template is up to date (v0.14.0)
```

## Flow

1. Scan workspace-context/ recursively — read all `.md` files and their frontmatter
2. Read CLAUDE.md — extract skill and rule references
3. Read workspace.json — extract repo manifest
4. Check `.claude/rules/`, `.claude/skills/`, `.claude/agents/` against references
5. Check git state (worktrees, branches, remotes)
6. Run `node .claude/scripts/build-workspace-context.mjs --check --root .` — capture status. Exit `0` = clean (and within budget when one is set), `1` = artifact missing or stale, `2` = artifacts current but canonical body over budget — only possible with a budget set. The `canonical` block in the JSON output drives both the audit budget line and the cleanup triage decision; `"budget": null` means the canonical budget is off.
7. Run `node .claude/scripts/context-footprint.mjs --root .` — capture the total and the `BUDGET` line. Exit `0` = within budget or no budget set; exit `1` = over budget, reported as a warning with the top contributors (audit step 6).
8. Read session-log.jsonl if it exists
9. If cleanup mode: regenerate the workspace-context auto-files if stale (index.md, canonical.md, per-user team-member indexes); compare files pairwise for overlap; scan for stale cross-references. If post-regen `--check` reports `over-budget`, enter the canonical-budget triage flow described in cleanup step 11.
10. Compile and present findings grouped by severity

## Notes
- Audit mode is always read-only — never modifies files
- Cleanup mode asks before acting on any suggestion
- Run before /release to catch drift before it compounds
- Run after long gaps between sessions to surface stale context
- Consider running at the start of each work session
