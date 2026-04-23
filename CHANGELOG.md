# Changelog

All notable changes to `@ulysses-ai/create-workspace` are documented here. Entries are written for users installing the package, not contributors — see the repository history for implementation detail.

## v0.14.0-beta.0 — 2026-04-23

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
