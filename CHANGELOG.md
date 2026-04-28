# Changelog

All notable changes to `@ulysses-ai/create-workspace` are documented here. Entries are written for users installing the package, not contributors — see the repository history for implementation detail.

## v0.15.0-beta.0 — 2026-04-28

- **`shared-context/` is now `workspace-context/`, with a three-layer trust gradient and reliable canonical auto-loading.** The previous `CLAUDE.md` line `@shared-context/locked/` was a no-op — Claude Code's `@`-import only resolves files, not directories, so canonical truths never actually reached the prompt despite the `locked/` convention. The new layout fixes this with `workspace-context/canonical.md`, an auto-generated verbatim concatenation of `workspace-context/shared/locked/*.md`, imported by `CLAUDE.md` directly. Canonical content now reliably appears in every session. Inside `workspace-context/`, three layers compose by location: `shared/locked/` for canonical team truths, `shared/` (root) for team-visible ephemerals, and `team-member/{user}/` for per-user working context. Personal drafts are loaded only for the active user via the gitignored `CLAUDE.local.md`, generated from `workspace.json` → `workspace.user`. This is a breaking rename — every directory, frontmatter convention, and skill reference moves from `shared-context` to `workspace-context`. Existing workspaces upgrade in place via `migrate-to-workspace-context.mjs`, run automatically by `/workspace-update` between maintenance passes. The migrator is idempotent and uses `git mv` to preserve history.
- **One generator, three artifacts.** `.claude/scripts/build-workspace-context.mjs` produces `workspace-context/index.md`, `workspace-context/canonical.md`, and per-user `workspace-context/team-member/{user}/index.md` files in a single pass. `--check` reports staleness for `/maintenance audit`; `--write` regenerates. Hand edits to any of the three are overwritten — source of truth is the underlying files (or their `description:` frontmatter). The previous `build-shared-context-index.mjs` is replaced by this generator.
- **Capture skills route through a centralized helper.** `/braindump`, `/handoff`, `/aside`, and `/promote` are rewritten as thin wrappers around `.claude/scripts/capture-context.mjs`, which owns path resolution, prefix application (`braindump_`, `handoff_`, `research_`), frontmatter writing, collision handling, and `--print-only` mode for subagent precomputed paths. `/aside --quick` writes locally with `variant: aside`; `/aside` (full) dispatches a researcher subagent with `--type research`. Locked files use bare names since location signals the type, so `/promote` strips the prefix when locking and `/release` does the same when synthesizing new canonical entries.
- **`shared-context` index now respects `.gitignore` (gh:84).** The previous index generator listed every `*.md` under shared-context, including `local-only-*` files that are gitignored by convention — personal drafts could leak into the team-shared index when their author triggered a regeneration. The new `build-workspace-context.mjs` filters via a single batched `git check-ignore --stdin` pass, alongside the existing `.indexignore` path-prefix excludes.

### Migration notes

- `npm run audit:tarball` still gates publish — confirm tarball is clean before tagging.
- Existing workspaces should run `/workspace-update` to apply the rename and pick up the new generator. The migrator handles the shared-context → workspace-context rename, the locked-import fix in `CLAUDE.md`, and `.indexignore`'s `release-notes/` prefix shift in one pass.
- `CLAUDE.local.md` is now gitignored by template default. Workspaces with a custom `CLAUDE.local.md` should verify it isn't tracked.

## v0.14.0-beta.3 — 2026-04-26

- Hotfix for v0.14.0-beta.2 publish: corrected `template/.claude/rules/memory-guidance.md` example to use a placeholder author rather than a real username (caught by tarball audit), and updated README hook count from 9 to 10 to match the version-freshness-check addition.

## v0.14.0-beta.2 — 2026-04-26 *(unpublished — superseded by beta.3)*

- **Workspace template freshness check.** Workspaces now know when the scaffolder template they were initialized from is outdated. A new SessionStart hook refreshes a 24-hour-cached check against npm and writes a `local-only-template-freshness.md` banner at the workspace root when a newer version exists; the banner is referenced from `CLAUDE.md` via `@local-only-template-freshness.md` so it surfaces under Claude Code CLI and ACP clients (Zed, JetBrains) alike. `/maintenance` reports the same delta in audit output. The check is gated by `workspace.versionCheck.ambient` in `workspace.json` (default `true` during beta; will flip to `false` at v1.0). Network behavior is conservative: offline conditions never break session start. Existing workspaces get the `@local-only-template-freshness.md` line added to `CLAUDE.md` automatically on `--upgrade` via an idempotent migrator.
- **Shared-context index and frontmatter conventions.** Each workspace now has an auto-generated `shared-context/index.md` — a one-line catalog of every shared-context file, grouped by lifecycle level (locked / root / user). The new `build-shared-context-index.mjs` script walks shared-context, reads frontmatter, and writes the index; `--check` reports staleness for `/maintenance audit`, `--write` regenerates for cleanup. A `shared-context/.indexignore` file accepts gitignore-style path-prefix lines for content like archived release notes. Two optional frontmatter fields are introduced: `description:` (one-line summary that feeds the index, with a body-sentence and filename-slug fallback when absent) and `confidence: high|medium|low` for research and design files. `/maintenance` gains an index-integrity audit step and validates `confidence` values. Hand edits to `index.md` are overwritten — source of truth is the filesystem.
- **Unscoped `local-only-*` gitignore convention.** The template's `_gitignore` previously scoped the `local-only-*` pattern to `.claude/rules/` and `shared-context/**/`, which let machine-local files at the workspace root (e.g., notes about a patched ACP adapter) fall through and show up as untracked. The pattern is now uniform: anything named `local-only-*`, at any depth, is ignored. New workspaces inherit it automatically; existing workspaces pick it up on next `/workspace-update`.

### Known issues

- The v1.0 default flip for `versionCheck.ambient` (true → false) lives in `AMBIENT_DEFAULT` in the freshness hook and in `template/workspace.json.tmpl`. No automation enforces it; it needs a manual edit at v1.0 release time.
- `shared-context/index.md` regenerates on `/maintenance`, not on every shared-context write. If drift between maintenance runs becomes annoying, a PostToolUse hook is a follow-up.
- About a third of bootstrapped index entries use weak fallback descriptions (filename-slug-derived). Adding `description:` to source files sharpens them; no batch backfill is mandated.
- The freshness banner file appears at the workspace root in Finder when behind. If clutter feedback emerges, an alternative placement under `workspace-scratchpad/` is available.
- The `/maintenance` audit assumes `process.cwd()` is the workspace root. Running it from inside a session worktree may produce inaccurate freshness/index reports — invoke from main.

## v0.14.0-beta.1 — 2026-04-24

- New `TodoWrite` ↔ `session.md` mirror. From `/start-work` onward, a lifecycle-aware checklist appears in Claude Code with `Start work`/`Complete work` bookends and an optional `> Linked: gh:42 — …` reference when the session is tied to a tracker issue. Tasks persist across chats, machines, and pause/resume cycles via a new `## Tasks` section in `session.md`, round-tripped by `.claude/scripts/sync-tasks.mjs`. Five skills (`/start-work`, `/pause-work`, `/complete-work`, `/handoff`, `/braindump`) flush at lifecycle moments so the durable store stays coherent.
- `/release` is now the sole owner of version bumps. `/complete-work` no longer touches `package.json`, eliminating a pre-existing double-bump that left versions disagreeing with the latest `CHANGELOG.md` entry between feature merge and release.
- Branch notes written by `/complete-work` now live in the workspace repo at `release-notes/unreleased/{repo-name}/` instead of inside project repos. `/release` reads from the workspace and writes only `CHANGELOG.md` into project repos — internal retrospection no longer leaks to public package repositories.
- Hook commands in `template/.claude/settings.json` now fall back to `$PWD` when `CLAUDE_PROJECT_DIR` is unset. Resilient to ACP adapter spawn paths (e.g. some Zed configurations) that omit the env var, with no change to the common path where Claude Code CLI or the Agent SDK already sets it. The Windows `cygpath` wrapper is preserved.

### Known issues

- Dogfood workspaces may have an older `.claude/lib/` that is missing `require-node.mjs`. A follow-up `chore` or one-shot `/workspace-update` catches it up.
- GitHub's web renderer displays the new `- [-]` in-progress checkbox marker as literal text rather than an interactive checkbox. `session.md` is usually read in editors (Obsidian, JetBrains, etc.) where the marker renders correctly.
- Workspaces upgrading from a pre-v0.14 `/complete-work` may have leftover `release-notes/unreleased/branch-release-*.md` files in project repos from the old flow. Not auto-migrated; remove manually or via a follow-up chore.

## v0.13.0-beta.5 — 2026-04-22

- Replaced the `release-notes/v{version}.md` + `archive/` pattern with a single `CHANGELOG.md` at each project repo's root. The `/release` skill now prepends a concise, user-facing entry to `CHANGELOG.md` and deletes the consumed branch notes under `release-notes/unreleased/` — the long tail of per-version docs no longer accumulates in public repos.
- `release-notes/unreleased/` remains the intermediate capture zone for `/complete-work`; the directory is emptied every `/release` run.

## v0.13.0-beta.4 — 2026-04-22

- Generalized viewport-screenshot pitfall guidance in the `build-docs-site` skill so it no longer names Playwright specifically. The underlying issue and its workaround (full-page screenshots or DOM inspection via the automation tool's evaluate hook) apply to any browser automation tool.
- Hard Node 20.9+ runtime check inside initialized workspaces. Hooks and helper scripts now exit with a clear error on older Node instead of failing deep with cryptic syntax errors.
- The `/maintenance` skill's locked-context audit now reports the share relative to the active model's context window (yellow at 5%, red at 15%) rather than raw bytes.
- Token-economics rule rewritten with an explicit command-discipline checklist, and a new `bash-output-advisory` PreToolUse hook surfaces warnings when risky bash patterns are about to run.

## v0.13.0-beta.0 — 2026-04-17

First public beta on npm, published under the `beta` dist-tag as `@ulysses-ai/create-workspace`. Install with `npm install @ulysses-ai/create-workspace@beta` or scaffold with `npm create @ulysses-ai/workspace@beta`. This release consolidated the prior development arc into a publishable shape: hardened publish infrastructure with a tarball audit step, a public README that explains the workspace lifecycle and structure, the first documented logo, an eleven-chapter concepts reference, three getting-started guides (solo / team-lead / new-team-member), and a CI publish workflow with tag-based dist-tag routing.

## Pre-beta development — 2026-03 to 2026-04-16

The scaffolder evolved from a basic workspace initializer into a multi-session, multi-repo orchestrator. Work sessions became persistent named entities with cross-chat continuity, each living in a self-contained `work-sessions/{name}/` folder with the workspace worktree at its root and project worktrees nested inside. Session state consolidated into a single unified tracker with lossless frontmatter handling. The `/build-docs-site` skill shipped as a multi-phase orchestrator for Docusaurus sites with theme-aware diagrams. The tracker-adapter interface shipped at v0.11.0, setting up the swappable backend abstraction that GitHub Issues now implements. Platform support extended to Windows. Detailed per-version retrospectives from this period are preserved in the workspace repository, not in the public package.
