---
branch: chore/pre-publish-brand
type: chore
author: myron
date: 2026-04-17
---

## Pre-publish brand: GitHub repo rename + logo

Two pre-publish polish items, bundled so v0.12.2's published README ships consistent from the first publish onward.

### GitHub repo rename

`ukt-solutions/create-ulysses-workspace` → `ukt-solutions/create-workspace`. Aligns the GitHub identity with the package identity (`@ulysses/create-workspace`) shipped in v0.12.1. GitHub auto-redirects every URL forever, so existing links keep working. Considered moving to a Ulysses-named org but the bare `ulysses` GitHub handle is taken (active user since 2009); the npm scope `@ulysses/...` already does the brand work, so the GitHub URL staying under `ukt-solutions` is fine.

Updated:

- `package.json` `repository`/`homepage`/`bugs` URLs
- README documentation links (10+ absolute URLs to chapters and guides)
- `workspace.json` `repos.create-ulysses-workspace.remote` (the dogfood workspace's manifest entry — local key kept the same to avoid local-clone churn)
- Local git remotes in the worktree and source clone (`git remote set-url`)

### Logo

Logo from a Gamma design, sourced and committed at `docs/assets/logo.png`. Navy vertical mast with a coral coiled rope wrapped around it and "Ulysses" wordmark below — visually illustrates the lashed-to-the-mast metaphor in the README's "Why Ulysses?" section. Cream background (not transparent), reads cleanly as a deliberate "logo card" on both light and dark mode.

Displayed at the top of `README.md` via a centered HTML `<img>` tag at 220px width, sourced from the GitHub raw URL (`raw.githubusercontent.com/ukt-solutions/create-workspace/main/docs/assets/logo.png`) so it renders on both GitHub and npmjs.com. The `docs/` directory isn't in the npm tarball (the `files` allowlist excludes it), so the absolute URL is the right call — no tarball bloat, and the image lives in the repo where it can be revised without re-publishing.

### Verification

`npm run audit:tarball` passes after all changes — same 86 files, 104.0 kB tarball.

### Follow-ups

- **Set the GitHub repo's social preview image** to the same logo (1280×640 with the square logo centered + padding). UI-only setting in GitHub repo settings; no API write available, so this is a manual step at `https://github.com/ukt-solutions/create-workspace/settings`.
- **Transparent logo variant** (re-export from Gamma) — deferred. Cream background works as a logo card; transparent would let it visually float on any theme. Pick up if polish desire grows.
