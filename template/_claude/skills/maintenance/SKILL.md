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

The mechanical checks are scripted (gh:180) — run the audit and present its report:

```bash
node .claude/scripts/maintenance-audit.mjs --root .
```

The report prints one block per section — ✓ ok lines, ✗ issues, ⚠ warnings, ℹ infos — then a result summary. Severity drives the exit code: any issue-severity finding → exit `1`, otherwise `0` (a non-zero exit is the report above it, not a crash). `--offline` skips section 7, the only network user; `--json` emits `{issues, summary}` instead of the human report when another step needs the machine-readable numbers.

Sections 1–7 below explain what the script checks, so its findings can be interpreted. Each also names what it does not carry — those residual checks Claude performs alongside the script run.

### 1. Cross-reference consistency
The script checks the CLAUDE.md skill list against `.claude/skills/` in both directions, and walks CLAUDE.md's `@`-import graph for dangling imports. A missing `local-only-*` file or the optional `CODEBASE.md` stub is info, not an issue — expected states on machines that never generated them.

Semantic drift between context files — one saying "2 mandatory rules" when there are now 4, or two files contradicting each other — is not mechanically decidable; cleanup step 10's reconciliation covers it.

### 2. Frontmatter integrity
For each non-gitignored workspace-context `.md` and each `work-sessions/*/workspace/session.md`, the script checks:
- Frontmatter parses
- Session trackers carry `name`, `status`, `branch`
- `branch` references a branch that still exists
- `repo`/`repos` reference repos in workspace.json
- `lifecycle: active` untouched in 7+ days (stale candidate)
- `lifecycle: resolved` (info — confirm /complete-work has processed it)
- `confidence`, when set, is one of `high`, `medium`, `low`

### 3. Workspace structure
The script checks that workspace.json and CLAUDE.md are present and parseable, that `workspace-context/` and `.claude/rules`, `skills`, `scripts` directories exist, and that every manifest repo is cloned under `repos/`.

It also checks the template-modification registry (`.claude/template-modifications.json`, the workspace's record of files it owns outright or deliberately edits): legacy keys still in workspace.json (`workspace.localFiles`, `workspace.templateModifications`), keys that escape `.claude/` (the registry covers `.claude/` paths only — root files are handled by their own merge paths), and registrations whose file has gone back to the template's baseline content are info — `/workspace-update` offers the cleanups. A registry that doesn't parse is a warning: its localFiles exclusions and reasons are being ignored, and the update flow stops on it.

### 4. Git state
The script covers the launcher itself: on its default branch, tracked tree clean. Untracked paths are info — gitignored content is not counted.

It also lists leftover Claude Code agent worktrees (gh:205). A subagent with worktree isolation gets `.claude/worktrees/agent-{id}/` on a `worktree-agent-{id}` branch — in the workspace repo and in each `repos/*/`. Claude Code removes a clean one when the subagent finishes and sweeps the rest past `cleanupPeriodDays`, but the sweep keeps any worktree holding work, and a subagent that commits without pushing is exactly that, indefinitely. Per its docs, Claude Code locks a worktree while its agent runs. Each leftover is one info finding plus a `summary.agentWorktrees` entry (`--json`) carrying the facts and a scripted verdict: `removable` is true only when the worktree is clean (untracked files count as dirty), holds no work of its own (`commitsBeyond: 0`, or only non-merge commits whose patch-ids all landed on `base` per `git cherry` — which sees rebase and cherry-pick landings `--merged` misses; a squash merge leaves patch-ids unmatched, so a squash-merged branch is deliberately not removable), is not locked, has been idle for over an hour (newest of the HEAD reflog entry and the directory mtime), and is claimed by no chat-record task. `reasons` lists every failed gate. Cleanup step 9 offers removal only for `removable: true` entries — the safety call is scripted, not re-derived from prose.

The remaining worktree-level checks are not carried by the script; perform them alongside it:
- Worktrees with no recent commits? (orphaned)
- Local branches with no remote tracking? (unpushed work)
- Worktrees whose branch has already been merged? (cleanup candidates)
- Orphan worktree records in project repos — run `git -C repos/{repo} worktree list` for each repo and flag any `prunable` markers. These usually come from a workspace-first teardown (the unsafe order) leaving stale admin records behind. Suggest `git worktree prune` on the affected repo.
- Task-model state (gh:146), three checks:
  - **Unrecorded task worktrees** — list `repos/*/.claude/worktrees/*` and `.claude/worktrees/*`, read each candidate's branch (`git -C "{path}" rev-parse --abbrev-ref HEAD`), and keep only those on a task-prefixed branch (`feature/`, `bugfix/`, `chore/`) — Claude Code's own worktrees carry other branch names, so the prefix filter skips them without guessing a name convention. Cross-reference the chat records (`node .claude/scripts/chat-record.mjs --root . --list`): a task-prefixed worktree no record entry claims is *unrecorded* — it may be a legitimate no-tracker task (those are never recorded), so present it and ask before suggesting `node .claude/scripts/task-worktree.mjs --root . --remove --repo "{repo}" --branch "{branch}"`.
  - **Stale record entries** — a record task entry whose worktree is gone (neither `repos/{repo}/.claude/worktrees/{slug}/` nor, for `repo: "."`, `.claude/worktrees/{slug}/` exists). Suggest `node .claude/scripts/chat-record.mjs --root . --remove-task --chat "{chat}" --work-item "{workItem}" --repo "{repo}"` (omit `--repo` when the entry has none).
  - **Merged but never completed** — a recorded task branch that already merged. Judge merged-ness by the forge's merged PRs for that repo, matching on head branch — never `git branch --merged`, which a squash merge (never an ancestor) silently misses. `/complete-work` never ran. Suggest running `/complete-work` for that branch (detection from the chat record finds it).

### 5. Workspace-context auto-file integrity
The script regenerates `workspace-context/index.md`, `canonical.md`, and each `workspace-context/team-member/{user}/index.md` in memory and compares fingerprints — the same semantics as `build-workspace-context.mjs --check`:
- Missing or stale artifact → issue; regenerate with `node .claude/scripts/build-workspace-context.mjs --write --root .`
- A missing gitignored per-user index → info (regenerated per machine, the normal fresh-checkout state)
- Canonical body over budget after trim and stub → warning, deferred to cleanup triage
- Trimmed or stubbed but within budget → info

The canonical budget is opt-in: `workspace.canonicalBudgetBytes` off (absent or `null`) means canonical ships every locked file in full and over-budget cannot occur. When set, selection walks `ok` → `trimmed` → `stubbed` → `over-budget` as the generator gives up progressively more reference content to fit: `trimmedFiles` are reference files whose `<!-- canonical:trim --> ... <!-- canonical:end-trim -->` spans were dropped, `stubbedFiles` are reference files reduced to a one-line breadcrumb. `over-budget` means the budget is still exceeded after stubbing — regeneration cannot fix it; the locked content itself needs triage via `/maintenance cleanup` (step 11). Stale wins over over-budget: a stale canonical is reported as stale, hiding any over-budget condition until it is regenerated.

Residual, not in the script: while reading the indexes, flag filename-slug-only descriptions (e.g., "project status" with no period) — usually the source file is missing a `description:` or has no usable opening sentence. Suggest adding `description:`; the index picks it up on the next regeneration.

### 6. Always-loaded context budget
The script measures everything Claude reads at launch — CLAUDE.md, its @-imports, and the active rules — against `workspace.alwaysLoadedBudgetBytes`. Rules with `paths:` frontmatter are conditional (they load only when a matching file is touched) and count separately; with no budget in workspace.json the check passes trivially.

Within budget → an OK line (`✓ Always-loaded context: 43 KB / 64 KB`). Over → a warning — the workspace still functions; this is drift, not breakage — naming the top contributors. Fixes: scope situational rules with `paths:` frontmatter, or move reference content to `shared/`.

### 7. Template freshness
The script invokes `refreshIfStale` with a 24h TTL regardless of `workspace.versionCheck.ambient` — the user explicitly ran `/maintenance` — and reports:
- `outdated` → warning: `Template v{current} → v{latest} available. Run npx @ulysses-ai/create-workspace --upgrade.`
- `current` → ✓ Template is up to date (v{latest})
- `unknown` → warning: could not reach the npm registry
- `skipped: 'uninitialized'` → info: workspace not initialized, freshness check unavailable

An `outdated` result also rewrites the `local-only-template-freshness.md` banner and the version cache, as this check always has.

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
- Leftover Claude Code agent worktrees (gh:205) — the audit script's info findings (or `summary.agentWorktrees` via `--json`) carry each one's facts with a scripted `removable` verdict and the `reasons` behind it. Offer removal one worktree at a time, always asking first, and only for entries marked `removable: true` — the script has already verified the worktree is clean (untracked files count as dirty), holds no work of its own (`commitsBeyond: 0`, or only non-merge commits whose patch-ids all landed on the base per `git cherry`; a squash merge leaves patch-ids unmatched and is deliberately not removable), is unlocked, has been idle for over an hour, and is claimed by no chat-record task. Never widen these criteria by hand. For `removable: false` entries, report the `reasons` and leave the worktree alone; a locked one means Claude Code considers an agent running — the user may `git worktree unlock <path>` by hand if they know the agent is dead, and a later audit re-verdicts it. Removal is `git worktree remove <path>` (never `-f` — a refusal means the worktree no longer matches the recorded facts) then `git branch -D <branch>`, run in the owning repo (the workspace repo for `repo: "."`, `repos/{repo}/` otherwise). Never touch task worktrees: task-prefixed branches never reach the agent list, and claimed agent branches are already excluded by the script.
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

This step runs only when a canonical budget is set (`workspace.canonicalBudgetBytes` holds a number) and the post-regen `--check` from the cleanup regen pass (Flow step 4) still reports `selectionStatus: 'over-budget'`. With the budget off — absent or `null` in workspace.json — `--check` can never report over-budget, so this step is unreachable. Skip it too if the regular regen pass cleared the budget, or if `--check` was already `ok`, `trimmed`, or `stubbed` after that pass.

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
- Canonical budget — read from the audit script's section 5 outcome (the same regenerate-and-compare it already ran). When a budget is set, reported as `current / budget` bytes with the selection status (e.g., `full`, `2 reference files trimmed`); over-budget cases are deferred to the cleanup triage flow rather than re-reported here. When off, report the step 5 one-liner: `• Canonical budget: off (alwaysLoadedBudgetBytes covers the total)`.
- Always-loaded context — read from the audit script's section 6 outcome, reported the same way (`current / budget` bytes); over-budget is already surfaced as a warning there.
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

1. Run `node .claude/scripts/maintenance-audit.mjs --root .` and present its report — it carries audit sections 1–7. Add `--offline` when there is no network (section 7 is the only network user), or `--json` when step 13's health metrics or cleanup step 9's agent-worktree pass want the machine-readable `summary.canonical` / `summary.alwaysLoaded` / `summary.agentWorktrees` numbers.
2. Perform the residual checks the script does not carry — the worktree-level git checks from audit section 4 (orphaned worktrees, unpushed branches, merged worktrees, prunable worktree records, the task-model checks against `chat-record.mjs --list`).
3. Read session-log.jsonl if it exists (feeds step 13's session log stats)
4. If cleanup mode: run `node .claude/scripts/build-workspace-context.mjs --check --root .` — exit `0` = clean (and within budget when one is set), `1` = artifact missing or stale → regenerate with `--write`, `2` = artifacts current but canonical body over budget (only possible with a budget set). The `canonical` block in the JSON drives the triage decision; `"budget": null` means the canonical budget is off. Then compare context files pairwise for overlap and scan for stale cross-references; if the post-regen `--check` reports `over-budget`, enter the canonical-budget triage flow described in cleanup step 11.
5. Compile and present findings grouped by severity (Output Format above): the script's findings plus the residual checks, with cleanup suggestions from steps 3–4 folded in.

## Notes
- Audit mode is always read-only — never modifies files
- Cleanup mode asks before acting on any suggestion
- Run before /release to catch drift before it compounds
- Run after long gaps between sessions to surface stale context
- Consider running at the start of each work session
