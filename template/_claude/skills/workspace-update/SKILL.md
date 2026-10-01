---
name: workspace-update
description: Apply a staged template update to an initialized workspace. The CLI stages a payload in .workspace-update/; this skill processes it and verifies the result with a scripted audit.
---

# Workspace Update

Apply a staged template update to an initialized workspace. The CLI (`npx @ulysses-ai/create-workspace --upgrade`) stages the payload in `.workspace-update/`. This skill reads and applies it, then verifies the result with the scripted maintenance audit — one audit, at the end, when there is something to verify (gh:180).

## Prerequisites

- `workspace.json` must have `initialized: true`
- If not initialized, check whether initialization was committed but never merged — the workspace-init flow ends with its commits merged to the default branch, so an unmerged init branch explains a missing flag:
  ```bash
  git log --all --format=%H -S'"initialized": true' -- workspace.json
  ```
  If there are hits, name the branch holding the newest commit (`git branch --all --contains {sha}`) and report: "This workspace was initialized on branch `{branch}`, but that branch was never merged. Merge it first (`git merge {branch}`), then re-run /workspace-update." Only if there are no hits, report: "Workspace not initialized. Run /workspace-init first."
- `.workspace-update/` payload directory must exist (staged by `npx @ulysses-ai/create-workspace --upgrade`)
- If no `.workspace-update/` payload exists, report: "No update payload found. Run `npx @ulysses-ai/create-workspace --upgrade` to stage the template."
- Read `.workspace-update/.manifest.json` for `fromVersion`, `templateVersion` (the target version), and `action`
- If `action` is `"init"`, report: "This payload is for initial setup. Run /workspace-init instead."

## Flow

### Step 1: Decide where the update lands

Check the workspace repo for a remote (`git remote`). This decides where every later step works:

- **No remote** — apply in place. The Step 7 commit lands on the launcher's default branch: the one sanctioned launcher commit, because a repo with no remote has nowhere else for a template update to go. The payload path is `.workspace-update/`.
- **A remote exists** — the launcher never commits to its default branch. Create a task worktree up front and treat it as the workspace root for Steps 2–6:
  ```bash
  node .claude/scripts/task-worktree.mjs --root . --create --repo . --branch chore/template-update-{version}
  ```
  The payload is untracked, so it does not appear inside the worktree — keep referencing it at the launcher's absolute path (`{launcher}/.workspace-update`). Step 7 commits, pushes, and PRs from the worktree.

In the commands below, `{payload}` is `.workspace-update` in the no-remote flow and `{launcher}/.workspace-update` in the worktree flow.

### Step 2: Classify the payload

Run the classifier — it compares every verbatim-installed payload file (`.claude/**`, `.mcp.json`, `.claudeignore`) against the workspace by content, and detects files the template no longer ships:

```bash
node {payload}/.claude/scripts/classify-update.mjs --root . --payload {payload}
```

It runs from the payload precisely so workspaces that don't have it installed yet can use it; once installed, `node .claude/scripts/classify-update.mjs --root .` is equivalent. Output is JSON with five lists:

- `new` — no installed counterpart; safe to batch-apply (Step 3) behind one confirmation
- `identical` — installed file already equals the payload; skip silently
- `differs` — installed file was locally modified; needs a per-file decision
- `activated` — the payload ships `rules/{name}.md.skip` while the workspace keeps `{name}.md` active: the rule was deliberately activated. Nothing to install — the active rule stays.
- `removed` — installed file with no counterpart in the payload. Tests (`*.test.mjs`), gitignored paths, `.claude/worktrees/`, and files listed in `workspace.json` → `workspace.localFiles` (an array of `.claude/`-relative paths or globs the workspace owns) are excluded automatically, so only real template removals are listed.

Templates (`*.tmpl`, which install with `{{project-name}}` substitution), `_gitignore` (merged line-by-line), and `.manifest.json` (payload metadata) are not classified — each is handled by its own sub-step in Step 3.

Report with version info from the manifest:
```
"Template update: v{fromVersion} → v{templateVersion}. {N} new files, {M} locally modified, {A} activated rules, {R} removed files, {K} unchanged."
```

If `new`, `differs`, `activated`, and `removed` are all empty, report: "Workspace is up to date (template v{templateVersion}). No changes needed."

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

Batch the safe case, ask on the rest:

- **New files (`new`):** present the list once — "Apply these {N} new files? [Y/n]" — and install them all on confirmation. No per-file prompting.
- **Locally modified (`differs`):** ask per file — "Template updated {file} but you have local changes. Show diff? [y/N]" — then apply, keep, or merge per the user's decision.
- **Removed in template (`removed`):** "Template removed {file}. Delete locally? [y/N]" — conservative default.
- **Activated rules (`activated`):** keep the active file, install nothing — report: "Rule {name} is active here and optional in the template; your activation is preserved."
- **Hook migration (.sh to .mjs):** Detect old `.sh` hooks in `.claude/hooks/` that have `.mjs` replacements in the payload. Offer: "Hook {name}.sh has a .mjs replacement in the update. Replace and update settings.json commands? [Y/n]" — this is a one-time migration for workspaces upgrading from pre-0.2.0

Also handle these non-component files from the payload:

- **settings.json:** Merge payload values into existing `.claude/settings.json` — do not overwrite user customizations. Add new keys, update hook commands if hooks were migrated, preserve user-added entries.
- **workspace.json keys:** Compare the `workspace` object of the payload's `workspace.json.tmpl` with the installed `workspace.json`, key by key. For each key the template ships that the workspace lacks, show its template default and ask before adding. Never remove an existing key just because the template no longer ships it. `canonicalBudgetBytes` is opt-in since v0.19 — leave an existing value alone and mention it can be removed to turn the budget off.
- **CLAUDE.md:** If `{payload}/CLAUDE.md.tmpl` exists, regenerate `CLAUDE.md` from the template. Preserve any user-added sections not present in the template.
- **.gitignore:** Merge new entries from the payload's `_gitignore` into the existing `.gitignore` — do not remove user-added lines.

### Step 4: Update version

Read `templateVersion` from `.workspace-update/.manifest.json` and update `templateVersion` in `workspace.json` to match.

### Step 4a: Run idempotent migrators

Two migrators run on **every** update — both idempotent, safe on already-migrated workspaces. Run each and surface its action in the upgrade summary.

```bash
node {payload}/.claude/scripts/migrate-claude-md-freshness-include.mjs --root .
```

Output is JSON: `{"action":"appended"|"unchanged"|"skipped"}`.

- `appended` — the workspace's `CLAUDE.md` got the `@local-only-template-freshness.md` include line added at the end.
- `unchanged` — the line was already present.
- `skipped` — no `CLAUDE.md` exists at the workspace root (rare; surface to the user).

```bash
node {payload}/.claude/scripts/migrate-canonical-priority.mjs --root .
```

Output is JSON: `{"status":"applied"|"noop","files":[...]}`. Back-fills `priority: critical` on every `workspace-context/shared/locked/*.md` that lacks the field, preserving today's full-load behavior until the user explicitly demotes a file. Skips `local-only-*` files — they are machine-local, never canonical.

The other `migrate-*.mjs` in the payload are **one-shot, version-gated migrations**: each applies to a specific step of the template's history and runs only when the manifest's `fromVersion` is older than the version that introduced it. Never run them unconditionally.

- `migrate-session-layout.mjs` — pre-v0.10.0 → v0.10.0: moves session content from launcher-side paths into each session's workspace worktree.
- `migrate-to-workspace-context.mjs` — pre-v0.15.0 → v0.15.0: renames `shared-context/` to `workspace-context/` and rebuilds its structure.
- `migrate-sessions.mjs` — pre-v0.18.0: drains session-model work sessions onto the task lifecycle. Not run inline — it has interactive inventory/backup/archive modes; `/migrate-sessions` drives it (Step 8 nudges when it applies).
- `migrate-open-work.mjs` — manual, any version: converts the deprecated `open-work.md` into tracker issues. Takes the file path as an argument and needs a configured tracker; run it only if the workspace still carries an `open-work.md` and the user asks.

Always run migrators with `--root .`. They resolve the workspace root from `--root` (default: the cwd) and never from their own location — a migrator invoked from the payload without `--root` would look for the workspace inside `.workspace-update/`.

### Step 5: Post-update verification

First regenerate the context catalogs — an update that adds or renames files under `.claude/` or `workspace-context/` leaves `index.md`/`canonical.md` stale until they are rebuilt:

```bash
node .claude/scripts/build-workspace-context.mjs --write --root .
node .claude/scripts/build-workspace-context.mjs --check --root .
```

`--check` must exit clean. If it reports drift, re-run `--write` and check again before continuing.

Then run the scripted audit — once, covering everything (gh:180). Build the changed list — every file this update added or changed: the applied `new` and `differs` files plus the merged ones (`CLAUDE.md`, `workspace.json`, `.gitignore`, `.claude/settings.json`, `.mcp.json` as touched) — one path per line into a temp file such as `workspace-scratchpad/update-changed.txt`, then:

```bash
node {payload}/.claude/scripts/maintenance-audit.mjs --root . --changed workspace-scratchpad/update-changed.txt
```

Run it from the payload for the same reason as the classifier in Step 2: the workspace's own copy may predate this update. It reuses the sections of `/maintenance` audit that a script can decide (cross-references, frontmatter, structure, git state, catalog integrity, budgets, freshness) and marks findings on changed files `(from this update)`.

Present its report as the verification result. Git-state warnings are expected here — the update's commit hasn't landed yet (Step 7). Delete the temp changed list afterwards.

- Findings labeled `(from this update)` — caused by this update; fix before committing (usually a new skill missing from CLAUDE.md's list, or a stale catalog).
- Other findings — pre-existing; mention briefly.
- If the audit found issue-severity findings, offer to walk through them with the full `/maintenance` skill. Warnings and infos alone need no follow-up.

Report: "Post-update verification: {N} issues found" or "Post-update verification clean."

### Step 6: Cleanup

Delete the `.workspace-update/` directory at the launcher — in the worktree flow (Step 1) that happens after the merge and pull in Step 7. The payload has been fully processed and is no longer needed.

### Step 7: Commit

Where the commit lands was decided in Step 1.

- **No remote:** commit in place on the launcher's default branch — the one sanctioned launcher commit:
  ```bash
  git add -A
  git commit -m "chore: update workspace from template v{fromVersion} to v{templateVersion}"
  ```
- **Remote exists:** from the task worktree created in Step 1, commit the applied update, push the branch, and open a PR through the forge adapter — `node .claude/scripts/task-pr.mjs` when the workspace has it, otherwise the adapter under `.claude/scripts/forges/`. After the PR merges, pull the launcher, then delete the payload (Step 6).

Report: "Workspace updated to v{templateVersion}. Restart Claude Code if rules or hooks changed."

### Step 8: Session-model migration nudge

After the update is applied, if the sessions directory (`workspace.workSessionsDir`, default `work-sessions/`) has entries and `workspace.sessionModel` is not `"task"`, append one line to the report: "This workspace still has {N} session(s) under the session model — `/migrate-sessions` can inventory and drain them and switch to the task model whenever you're ready." Suggest only; the operator decides whether and when.

## Notes

- The CLI (`npx @ulysses-ai/create-workspace --upgrade`) stages the payload. This skill processes it.
- Never overwrites without asking — `new` files are batched behind one confirmation; `differs` files are asked per file
- Preserves local modifications, custom content, existing `workspace.json` keys, and deliberately activated rules
- The launcher's default branch takes a template-update commit only when the workspace has no remote; with a remote, the update lands through a task worktree and a PR
- Can be run multiple times safely (idempotent) — if `.workspace-update/` doesn't exist, it reports no payload and exits
- Initial setup is handled by `npx @ulysses-ai/create-workspace --init` + `/workspace-init` — this skill is for subsequent updates only
- The `.sh` to `.mjs` hook migration is a one-time transition for workspaces created before hooks moved to JavaScript
- The post-update audit is read-only and non-blocking — it surfaces issues, labels the ones this update caused, and never prevents the update itself
