# Changelog

All notable changes to `@ulysses-ai/create-workspace` are documented here. Entries are written for users installing the package, not contributors — see the repository history for implementation detail.

## v0.13.0-beta.4 — 2026-04-22

- Generalized viewport-screenshot pitfall guidance in the `build-docs-site` skill so it no longer names Playwright specifically. The underlying issue and its workaround (full-page screenshots or DOM inspection via the automation tool's evaluate hook) apply to any browser automation tool.
- Hard Node 20.9+ runtime check inside initialized workspaces. Hooks and helper scripts now exit with a clear error on older Node instead of failing deep with cryptic syntax errors.
- The `/maintenance` skill's locked-context audit now reports the share relative to the active model's context window (yellow at 5%, red at 15%) rather than raw bytes.
- Token-economics rule rewritten with an explicit command-discipline checklist, and a new `bash-output-advisory` PreToolUse hook surfaces warnings when risky bash patterns are about to run.

## v0.13.0-beta.0 — 2026-04-17

First public beta on npm, published under the `beta` dist-tag as `@ulysses-ai/create-workspace`. Install with `npm install @ulysses-ai/create-workspace@beta` or scaffold with `npm create @ulysses-ai/workspace@beta`. This release consolidated the prior development arc into a publishable shape: hardened publish infrastructure with a tarball audit step, a public README that explains the workspace lifecycle and structure, the first documented logo, an eleven-chapter concepts reference, three getting-started guides (solo / team-lead / new-team-member), and a CI publish workflow with tag-based dist-tag routing.

## Pre-beta development — 2026-03 to 2026-04-16

The scaffolder evolved from a basic workspace initializer into a multi-session, multi-repo orchestrator. Work sessions became persistent named entities with cross-chat continuity, each living in a self-contained `work-sessions/{name}/` folder with the workspace worktree at its root and project worktrees nested inside. Session state consolidated into a single unified tracker with lossless frontmatter handling. The `/build-docs-site` skill shipped as a multi-phase orchestrator for Docusaurus sites with theme-aware diagrams. The tracker-adapter interface shipped at v0.11.0, setting up the swappable backend abstraction that GitHub Issues now implements. Platform support extended to Windows. Detailed per-version retrospectives from this period are preserved in the workspace repository, not in the public package.
