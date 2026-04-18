---
branch: feature/polish-and-publish
type: feature
author: myron
date: 2026-04-17
---

## Polish & Publish: shippable npm tarball with public-facing README and concept docs

The package is now safe to publish to npm. Four pieces of work landed together so positioning, voice, and definitions of done stayed coherent across them: a public-facing README rewrite, an audit pass over the existing concept and getting-started docs, hardening of the npm tarball, and a publish-time safety net.

### The README

The previous README was a 43-line stub that linked to docs that did not ship in the tarball — the relative `docs/...` links broke on npmjs.com. The new README is 104 lines, follows the genre conventions of `create-vite` / `create-next-app` / `create-astro`, and lands the product's positioning explicitly:

- A tagline drawn from the maintainer's own colleague-pitch: *"Rules, skills, and hooks that steer Claude Code through real work. Sessions you can pause and resume, multi-repo with versioning, shared context that survives chat boundaries."*
- A Quick start block showing all four package managers (npm, yarn, pnpm, bun) side by side, plus the post-install steps.
- A Why-Ulysses section that introduces the lashed-to-the-mast metaphor — the product name carries weight only if the README earns it, and this is where it does. Rules are the mast. Skills are how you row. Hooks are the lookouts.
- "What it gives you" framed as four lifecycle/structure bullets in the order users actually touch them: workflow lifecycle that survives chat boundaries, parallel sessions, multi-repo with versioning, shared context with a locked layer. Closes with chapter 01's load-bearing line: *"Everything Claude needs is in the file system. Everything a team shares is in git."*
- "What you get" with snapshot counts (14 skills, 6 active rules + 8 optional `.skip` rules, 8 hooks). The audit script enforces them at publish time so the prose can't drift from the template's actual contents.
- A CLI table that documents both the interactive `npm create ulysses-workspace@latest` form and the explicit `npx create-ulysses-workspace --init <dir>` form, with a callout explaining why both exist (npm consumes `--init` as its own subcommand alias, so the two invocations have different ergonomics).
- Documentation links use absolute GitHub URLs so they resolve on both the GitHub page and the npmjs.com package page.

### The concepts docs and getting-started guides

The 11 chapters under `docs/chapters/` and the three guides under `docs/guides/` were already well-written. The work was an audit pass against a 15-row concept-coverage matrix derived from `shared-context/documentation-seeds.md`, plus de-personalization of every example.

Findings and fixes:

- **Two concept gaps filled.** Chapter 11 gained a new pattern, "Discussion Sessions Don't Need /start-work," which formalizes the unwritten rule that chat sessions for thinking-out-loud should skip the work-session lifecycle entirely. Chapter 03 gained a new "When You Don't Want Preservation" section that contrasts `workspace-scratchpad/` (gitignored, lazy-created) with `shared-context/` (tracked, surviving workstation switches) — the absence of this contrast had been a low-grade point of confusion.
- **Rule list drift fixed.** Chapter 05 had been claiming "five mandatory rules" and "six optional `.skip` rules"; the actual counts were six and eight, with `work-item-tracking.md` missing from the active list and `local-dev-environment.md.skip` and `product-integrity.md.skip` missing from the optional list. The team-lead guide carried the same drift and now matches.
- **Terminology cleanup.** "Session marker" (deprecated) is now "session tracker" or "session folder," matching chapter 02's canonical usage. The `workItem` example switched from a bare integer to the adapter-prefixed form (`gh:42`) per the work-item-tracking rule, and the deprecated reference to `open-work.md` is gone.
- **De-personalization sweep.** Every `myron` reference in chapter examples and ship-in-tarball template files became `alice` (the standard CS placeholder). The `ukt-solutions/ulysses-workspace` example slug in `template/.claude/rules/work-item-tracking.md` became `your-org/your-workspace`. Test fixtures in `template/.claude/lib/session-frontmatter.test.mjs` got the same treatment.
- **`template/CLAUDE.md.tmpl` refreshed.** The skills list had drifted — `/aside` (added in v0.3.x) and `/build-docs-site` were missing, and `/setup-tracker`'s description still referenced the deprecated `open-work.md`. The list now matches the 14 directories under `template/.claude/skills/` exactly.

### npm-publish readiness

`package.json` gained the metadata that drives discoverability and safety on npmjs.com:

- `description` matches the README tagline.
- `keywords` expanded to eight terms (`claude`, `claude-code`, `anthropic`, `workspace`, `scaffold`, `monorepo`, `agent`, `cli`).
- `repository`, `homepage`, and `bugs` point to the public GitHub repo.
- `engines.node` is set to `>=20.9.0`, matching `create-next-app`'s well-tested floor (Node 18 is EOL).
- `scripts.audit:tarball` and `scripts.prepublishOnly` wire the new audit script to the publish flow.

Two new safety nets enforce what the metadata advertises:

- **Runtime Node version check** at the top of `bin/create.mjs`. The `engines.node` field is advisory — npm only warns by default — so the CLI now exits cleanly with a clear remediation message if Node is older than 20.9, regardless of `engine-strict` settings.
- **`scripts/audit-tarball.mjs`** runs in `prepublishOnly` and implements seven check categories: a content denylist scan with context-bound matching (so legitimate prose mentions of placeholder usernames don't fire false positives), a forbidden-file check, a required-file check, a settings-sanity scan against `template/.claude/settings.json`, a tarball-size bound (warns above 150 kB; current is 104 kB), a count-snapshot check that diffs the README's claimed counts against the filesystem, and a license-presence check. Negative-path tests confirm all categories trigger correctly.

A standard MIT `LICENSE` file at the repo root rounds out the publish-readiness work — `package.json` had been declaring MIT but no license text was shipping in the tarball.

### Verification

`npm run audit:tarball` returns clean. `npm pack --dry-run` shows 86 files at 103.9 kB — the same shape as before, plus the LICENSE. End-to-end install of the produced tarball into a scratch directory creates a working scaffold with the correct `{{project-name}}` substitution, all bootstrap skills, hooks, scripts, and lib files, and zero personal-reference leaks.

The package can ship via `npm publish` whenever the maintainer runs it. Publishing itself is intentionally not part of this work — the first publish locks the unscoped `create-ulysses-workspace` name and is a one-way door, so it stays a deliberate user-triggered action.
