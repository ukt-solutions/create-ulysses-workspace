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

Check the workspace repo for a remote:

```bash
git remote
```

ANY remote — even one you cannot push to — routes the update through a worktree: a commit made directly on the launcher's local default branch diverges from `origin/<default>` (the push is refused on a protected default branch, and later task worktrees based on `origin/<default>` cannot fast-forward past it). Never commit or push the launcher's default branch directly.

- **A remote exists (the normal case)** — create a task worktree up front and treat it as the workspace root for Steps 2–6:
  ```bash
  node {scripts}/task-worktree.mjs --root . --create --repo . --branch chore/template-update-{version}
  ```
  `{scripts}` is `.claude/scripts` when the workspace has the script, `{payload}/.claude/scripts` when it doesn't — pre-0.18 workspaces predate the task scripts entirely, and the payload always carries them (the same rule Step 2 already uses for the classifier). The payload is untracked, so it does not appear inside the worktree — keep referencing it at the launcher's absolute path (`{launcher}/.workspace-update`). Everything the update needs travels with the payload, including any `.template-baseline.reconstructed.json` the CLI staged for a pre-baseline workspace. Step 7 commits, pushes, and opens the PR/MR from the worktree.
- **No remote** — apply in place. The Step 7 commit lands on the launcher's default branch: the one sanctioned launcher commit, because a repo with no remote has nowhere else for a template update to go. The payload path is `.workspace-update/`.

In the commands below, `{payload}` is `.workspace-update` in the no-remote flow and `{launcher}/.workspace-update` in the worktree flow.

### Step 2: Classify the payload

Run the classifier — it compares every verbatim-installed payload file (`.claude/**`, `.mcp.json`, `.claudeignore`, minus the two JSON configs that get their own list below) against the workspace and the template baseline (`.claude/.template-baseline.json`, the hashes of what the template last shipped here), and detects files the template no longer ships:

```bash
node {payload}/.claude/scripts/classify-update.mjs --root . --payload {payload} --baseline {baseline}
```

It runs from the payload precisely so workspaces that don't have it installed yet can use it; once installed, `node .claude/scripts/classify-update.mjs --root .` is equivalent. `{baseline}` is whichever baseline the classification root has — `.claude/.template-baseline.json` when it exists there, else `{payload}/.template-baseline.reconstructed.json`, the file `--upgrade` stages for a pre-baseline workspace. Pass the flag explicitly in the worktree flow: the worktree cannot see launcher-only files, and without a baseline it classifies two-way and asks about every changed file. An explicit path is authoritative, so never point it at a file that may not exist. In the no-remote flow the flag can be omitted — the default resolves the same order itself (root baseline first, then the payload's reconstructed one, a corrupt root file counting as absent). Output is JSON:

- `new` — no installed counterpart and no baseline entry; safe to batch-apply (Step 3) behind one confirmation
- `identical` — installed file already equals the payload; skip silently
- `updated` — installed file still holds the baseline content while the payload ships something new: a pure template change the user never touched. Batched with `new` behind one confirmation
- `differs` — installed file matches neither the payload nor the baseline, and the template changed it since the baseline too: a local edit that meets a template change. Needs a per-file decision
- `config` — `.mcp.json` and `.claude/settings.json`: JSON the workspace owns jointly with the template — never compared by content, never batch-copied. Each entry carries a key-level diff (`added` keys the template ships, `workspaceOnly` keys only the workspace has, `changed` keys with different values; nested paths like `mcpServers/{server}`), element diffs for array-valued keys (`arrays`: `{ path, added, workspaceOnly }` element lists for `hooks/{event}`, `permissions/allow`/`deny`), or a `notInstalled` / `unparseable` flag. Merged key by key in Step 3.
- `localOnly` — installed file differs from the payload, but the payload equals the baseline: these are local edits to files the template didn't touch. Informational only — never asked about, never applied
- `deletedLocally` — the baseline records the file and the payload still ships it, but it is missing from the workspace (deleted locally, or declined at install time). Step 3 asks once whether to restore the list
- `activated` — the payload ships `rules/{name}.md.skip` while the workspace keeps `{name}.md` active: the rule was deliberately activated. Nothing to install — the active rule stays.
- `removed` — installed file with no counterpart in the payload. The config files above never appear here (the template dropping one hands it to the workspace). Gitignored paths, `.claude/worktrees/`, and files listed in `workspace.json` → `workspace.localFiles` (an array of `.claude/`-relative paths or globs the workspace owns) are excluded automatically. An entry is a plain path, `{ file, referencedBy }` — a hook a workspace-only `settings.json` entry still registers (the paths say where) — or `{ file, userOwned: true }` — no baseline record, so the template never shipped it and it is the workspace's own.
- `staleTests` — `*.test.mjs` files under `.claude/` the payload doesn't carry. The package never ships tests, so these came from a dev checkout and no update refreshes them (Step 3 offers removal).
- `implicitDefaults` — `workspace.json` keys whose absence carried a default in the version being upgraded from. Today: `canonicalBudgetBytes`, an implicit 40960-byte budget between v0.15.0-beta.1 and v0.19.0-beta.0 (before v0.15 there was no budget at all; since v0.19 absent means off). An upgrade from inside that window into a workspace.json that never set the key reports `{ key, value, reason }` — Step 3's workspace.json step writes the value explicitly so trimming doesn't silently stop.

Content is compared with line endings normalized (CRLF ≡ LF; binary files byte-exact), so a Windows autocrlf checkout does not read as locally modified.

If `hasBaseline` is false (no workspace baseline and the payload carries no reconstructed one — current `--upgrade` stages `.template-baseline.reconstructed.json` inside the payload whenever reconstruction succeeds), tell the user: "No template baseline — this first update asks about every changed file individually; once it finishes and writes the baseline (Step 4), later updates won't." Template changes then land in `differs`. `baselineSource` names which file was used and `baselineReconstructed` flags a reconstructed one.

Templates (`*.tmpl`, which install with `{{project-name}}` substitution), `_gitignore` (merged line-by-line), and `.manifest.json` (payload metadata) are not classified — each is handled by its own sub-step in Step 3.

Report with version info from the manifest:
```
"Template update: v{fromVersion} → v{templateVersion}. {N} new files, {U} template-updated, {M} locally modified, {C} config files to merge, {L} local-only edits, {D} deleted locally, {A} activated rules, {R} removed files, {K} unchanged."
```

If `new`, `updated`, `differs`, `config` (an entry with empty `added`/`workspaceOnly`/`changed` lists and no array elements to merge counts as empty), `deletedLocally`, `activated`, `removed`, and `implicitDefaults` are all empty, report: "Workspace is up to date (template v{templateVersion}). No changes needed." (`localOnly` files are informational and `staleTests` may still be worth offering.)

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

Commit the fix **before** applying other template updates — on the task branch in the worktree flow (Step 1), in place in the no-remote flow. This runs ahead of Step 3 because applying other updates while the bug is still present could itself trigger the destruction on workspaces that still have the old layout.

### Step 3: Selective update

Batch the safe cases, ask on the rest:

- **New and template-updated files (`new` + `updated`):** present both lists once — "Apply these {N} new and {U} template-updated files? [Y/n]" — and install them all on confirmation. No per-file prompting: `updated` means the file still holds exactly what the template last shipped here, so applying the new version loses nothing.
- **Locally modified (`differs`):** ask per file — "Your version of {file} differs from the template's. Show diff? [y/N]" — then apply, keep, or merge per the user's decision.
- **Config files (`config`):** `.mcp.json` and `.claude/settings.json` are never copied wholesale — a batch copy wipes the workspace's own MCP servers and settings. Merge each entry key by key (values from `{payload}/{path}` and the workspace's copy): add every `added` key, keep every `workspaceOnly` key untouched, and for each `changed` key ask — "Template changed `{key}` in `{path}`. Take the template's, keep yours, or inspect?" Array-valued keys merge as a union, no ask: keep the workspace's elements in place and append each `arrays` entry's `added` elements (`workspaceOnly` elements are already in place, listed for visibility). `notInstalled` — ask once: "Install {path} from the template? [Y/n]" (never install a config silently); `unparseable` means broken JSON on one side — show the file and ask, never merge blind.
- **Local-only edits (`localOnly`):** nothing to decide — these are your local edits to files the template hasn't changed since the last update. List them in the summary (so the edits are visible) and move on; do not ask about them.
- **Deleted locally (`deletedLocally`):** "These {N} files exist in the template and its baseline but not in your workspace — deleted locally (or never installed). Restore from the template? [Y/n]" — one confirmation for the whole list. Restoring installs the payload's version of each.
- **Removed in template (`removed`):** a plain path — "Template removed {file}. Delete locally? [y/N]" (conservative default). An entry `{ file, referencedBy }` is a hook still registered in `.claude/settings.json`: ask once — "Template removed {file}, which your settings.json still references via {refs}. Remove the file and those settings entries together? [Y/n]" — never delete the file and leave a settings entry pointing at nothing. An entry `{ file, userOwned: true }` was never shipped by the template (no baseline record): do not offer deletion — suggest claiming it in `workspace.json` → `workspace.localFiles` instead, showing the exact entry (`"localFiles": ["skills/my-skill/**"]`, or `["rules/my-rule.md"]` for a single file) so future updates skip it.
- **Activated rules (`activated`):** keep the active file, install nothing — report: "Rule {name} is active here and optional in the template; your activation is preserved."
- **Stale tests (`staleTests`):** "These {N} test files under .claude/ came from a dev checkout — the package never ships them, so updates can't refresh them (tests live in the template repo). Remove them? [Y/n]" — one confirmation for the whole list.
- **Hook migration (.sh to .mjs):** Detect old `.sh` hooks in `.claude/hooks/` that have `.mjs` replacements in the payload. Offer: "Hook {name}.sh has a .mjs replacement in the update. Replace and update settings.json commands? [Y/n]" — this is a one-time migration for workspaces upgrading from pre-0.2.0

Also handle these non-component files from the payload:

- **workspace.json keys:** First apply any `implicitDefaults` from Step 2 — write the reported key and value into the workspace.json being updated and tell the operator: "kept your previous canonical trimming (40 KB) explicitly; remove the key to turn it off." Then compare the `workspace` object of the payload's `workspace.json.tmpl` with the installed `workspace.json`, key by key. For each key the template ships that the workspace lacks, show its template default and ask before adding. Never remove an existing key just because the template no longer ships it. `canonicalBudgetBytes` is opt-in since v0.19 — leave an existing value alone and mention it can be removed to turn the budget off.
- **CLAUDE.md:** If `{payload}/CLAUDE.md.tmpl` exists, merge — never regenerate from scratch:
  ```bash
  node {payload}/.claude/scripts/classify-update.mjs --root . --payload {payload} --merge-claude-md
  ```
  The command prints JSON `{ claudeMd, missingIncludes }`. `claudeMd` is the merged CLAUDE.md: template-owned lines take the template's new versions (skill-list entries match by their `/name`), while lines the template doesn't have — the workspace's own skill entries, custom bullets, whole sections — are kept in place. `missingIncludes` lists the `@{file}` include lines the merged file carries whose targets don't exist here (machine-local `local-only-*` targets are exempt — expected absent, never reported). Two consequences to watch in the diff: an edit made directly to a template-owned skill line is replaced by the template's new wording, and a template prose line that was reworded locally survives alongside the new template line (it may appear twice). The merge keeps the current file's line endings. Show the user the diff against the current CLAUDE.md before writing the merged result, and act on each `missingIncludes` entry — ask "The merged CLAUDE.md includes `{file}`, which doesn't exist here. Create the stub, or leave the include out?" — never write a dangling include silently. (The two JSON configs are the `config` list's, not this block's.)
- **.gitignore:** Merge new entries from the payload's `_gitignore` into the existing `.gitignore` — do not remove user-added lines. An ignore pattern does not untrack already-committed files: if the workspace still tracks the per-machine catalogs the template now ignores (`git ls-files -- 'workspace-context/team-member/*/index.md'`), untrack them (`git rm -r --cached 'workspace-context/team-member/*/index.md'`), or every machine's regenerations keep dirtying pulls.

### Step 4: Update version and write the baseline

Read `templateVersion` from `.workspace-update/.manifest.json` and update `templateVersion` in `workspace.json` to match.

Then write the template baseline so the NEXT update classifies three ways instead of asking per file:

```bash
node {payload}/.claude/scripts/classify-update.mjs --root . --payload {payload} --write-baseline
```

Run it after every Step 3 decision has been made (it runs from the payload because the workspace's own copy may predate this update). In the worktree flow this writes the baseline inside the worktree (`--root .`), so it is committed through the PR and reaches every clone — and it reads the same baseline the classification used (the worktree has none of its own yet, so the payload's reconstructed file supplies the old entries a declined update keeps). It records the hash of every verbatim payload file — what the template now ships — with one deliberate exception: a file whose update was declined (the workspace still holds the old baseline content while the payload ships something new) keeps the OLD entry, so the change is offered again as `updated` next time instead of being filed away. Everything else records the payload hash: a file the user kept in their own version reads as `localOnly` (informational) until the template changes it again, and a file nobody touched never reads as a local edit. The command refuses to write an empty baseline — if it errors, the payload path is wrong; do not force it.

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

Then run the scripted audit — once, covering everything (gh:180). Build the changed list — every file this update added or changed: the applied `new`, `updated`, and `differs` files, any restored `deletedLocally` files, plus the merged ones (`CLAUDE.md`, `workspace.json`, `.gitignore`, `.claude/settings.json`, `.mcp.json` as touched) — one path per line into a temp file such as `workspace-scratchpad/update-changed.txt`, then:

```bash
node {payload}/.claude/scripts/maintenance-audit.mjs --root . --changed workspace-scratchpad/update-changed.txt
```

Run it from the payload for the same reason as the classifier in Step 2: the workspace's own copy may predate this update. It reuses the sections of `/maintenance` audit that a script can decide (cross-references, frontmatter, structure, git state, catalog integrity, budgets, freshness) and marks findings on changed files `(from this update)`.

Present its report as the verification result. Git-state warnings are expected here — the update's commit hasn't landed yet (Step 7) — and the launcher's replaced `workspace-update` skill copy is reported as info while it matches the payload's. Missing `@local-only-*` imports are info too (machine-local files never appear inside the worktree). Delete the temp changed list afterwards.

- Findings labeled `(from this update)` — caused by this update; fix before committing (usually a new skill missing from CLAUDE.md's list, or a stale catalog).
- Other findings — pre-existing; mention briefly.
- If the audit found issue-severity findings, offer to walk through them with the full `/maintenance` skill. Warnings and infos alone need no follow-up.

Report: "Post-update verification: {N} issues found" or "Post-update verification clean."

### Step 6: Cleanup

Delete the `.workspace-update/` directory at the launcher — in the worktree flow (Step 1) that happens after the merge and pull in Step 7. The payload has been fully processed and is no longer needed.

### Step 7: Commit

Where the commit lands was decided in Step 1 — the launcher's default branch is never pushed directly.

- **No remote:** commit in place on the launcher's default branch — the one sanctioned launcher commit:
  ```bash
  git add -A
  git commit -m "chore: update workspace from template v{fromVersion} to v{templateVersion}"
  ```
- **Remote exists:** from the task worktree created in Step 1, commit the applied update, push the branch, and open the PR/MR through `node {scripts}/task-pr.mjs` (`{scripts}` resolves as in Step 1 — the payload's copy whenever the workspace's own is missing). The workspace repo is addressed as `.`, so pass its PR body as `--body-file ".={path}"` (a repo with commits to merge but no body file is an error). If task-pr reports the forge unsupported, open the MR with the forge's own CLI (for GitLab, `glab mr create`) from the worktree and say so in the report. After the PR/MR merges, at the launcher and in this order:
  1. Restore the bootstrapped skill — `--upgrade` replaced `.claude/skills/workspace-update/` in the launcher (a tracked modification) and the merged PR delivers the same content, so a dirty launcher blocks the pull. If `SKILL.md.local-backup` sits there (a customised skill the CLI backed up), move it somewhere safe first (e.g. `workspace-scratchpad/`), then:
     ```bash
     git -C {launcher} checkout -- .claude/skills/workspace-update
     git -C {launcher} clean -f -- .claude/skills/workspace-update
     ```
  2. `git -C {launcher} pull --ff-only`
  3. Rebuild the catalogs — the pull can delete the gitignored per-user `workspace-context/team-member/{user}/index.md` (tracked before this update, untracked by it) that `CLAUDE.local.md` imports:
     ```bash
     node {launcher}/.claude/scripts/build-workspace-context.mjs --write --root {launcher}
     ```
  4. Remove the update worktree and its local branch:
     ```bash
     node {launcher}/.claude/scripts/task-worktree.mjs --root {launcher} --remove --repo . --branch chore/template-update-{version} --delete-branch
     ```
  5. Delete the payload (Step 6).

  Newly added skills appear only after this merge — start a new chat or `/reload` to pick them up.

Report: "Workspace updated to v{templateVersion}. Restart Claude Code if rules or hooks changed."

### Step 8: Session-model migration nudge

After the update is applied, if the sessions directory (`workspace.workSessionsDir`, default `work-sessions/`) has entries and `workspace.sessionModel` is not `"task"`, append one line to the report: "This workspace still has {N} session(s) under the session model — `/migrate-sessions` can inventory and drain them and switch to the task model whenever you're ready." Suggest only; the operator decides whether and when.

## Notes

- The CLI (`npx @ulysses-ai/create-workspace --upgrade`) stages the payload, installs the current copy of this skill into `.claude/skills/workspace-update/` (so an outdated installed flow never processes a new payload; a locally customised SKILL.md is backed up as `SKILL.md.local-backup` first), and stages a reconstructed baseline inside the payload as `.template-baseline.reconstructed.json` when the workspace has none — the launcher itself gets no new untracked files, and Step 7 restores the launcher's skill copy before the post-merge pull, rebuilds the per-user catalogs the pull may delete, and removes the update worktree with its branch
- Never overwrites without asking — `new` and `updated` files are batched behind one confirmation; `differs` files are asked per file; `config` files (`.mcp.json`, `.claude/settings.json`) are merged key by key (array-valued keys union-merged) and never copied wholesale; `localOnly` files are never asked about (local edits to files the template didn't touch)
- Preserves local modifications, custom content, the workspace's own MCP servers and settings, existing `workspace.json` keys, and deliberately activated rules
- The template baseline (`.claude/.template-baseline.json`) is what separates `updated`, `differs`, and `localOnly`: entries hold the payload hash of the last-shipped content (unapplied updates keep the older entry), so a deliberately kept local edit stays visible across updates while an untouched file never prompts
- The launcher's default branch takes a template-update commit only when the workspace repo has no remote; with ANY remote, the update lands through a task worktree, a branch, and a PR/MR — the default branch is never pushed directly
- Can be run multiple times safely (idempotent) — if `.workspace-update/` doesn't exist, it reports no payload and exits
- Initial setup is handled by `npx @ulysses-ai/create-workspace --init` + `/workspace-init` — this skill is for subsequent updates only
- The `.sh` to `.mjs` hook migration is a one-time transition for workspaces created before hooks moved to JavaScript
- The post-update audit is read-only and non-blocking — it surfaces issues, labels the ones this update caused, and never prevents the update itself
