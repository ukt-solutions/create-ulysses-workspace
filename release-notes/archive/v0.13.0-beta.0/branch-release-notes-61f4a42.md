---
branch: chore/scope-rename-to-ulysses
type: chore
author: myron
date: 2026-04-17
---

## Rename to `@ulysses/create-workspace` before first publish

The package was publish-ready as `create-ulysses-workspace` (unscoped) after v0.12.0, but the maintainer owns the `@ulysses` org scope on npm and the desktop app (per `shared-context/product-inventory.md`) will naturally ship as `@ulysses/app`. Switching to scoped before the first publish locks the family-of-packages convention and avoids a split brand where one Ulysses thing lives under `@ulysses/...` and another under `create-ulysses-workspace`.

### What changed

- **Package name:** `create-ulysses-workspace` → `@ulysses/create-workspace`. The `create-` prefix in the package name is part of the npm convention — `npm create @ulysses/workspace` resolves to `npx @ulysses/create-workspace`.
- **Bin name:** `create-workspace` (matches `@vitejs/create-vite` → `create-vite` convention).
- **CLI banner:** `Ulysses Workspace` (friendlier than the package slug; matches the README's brand voice).
- **README install commands:** all four package managers (npm/yarn/pnpm/bun) updated to the scoped form. CLI table updated. The "Why two forms?" callout still applies as written — `npm create` consuming `--init` is independent of scoping.
- **Documentation install commands:** chapter 10 (4 references) and the solo-developer + team-lead guides (1 each) all updated to `npx @ulysses/create-workspace`.
- **Template skill files** (`workspace-init`, `workspace-update`) and the Notion migration recipe updated to reference the new CLI invocation, since they ship in the tarball and instruct Claude inside scaffolded workspaces.
- **`lib/payload.mjs`** manifest `source` field updated to match the new package name.

### What stayed the same

- The GitHub repo URL (`ukt-solutions/create-ulysses-workspace`) in `package.json` `repository`/`homepage`/`bugs` and in the README documentation links. Renaming the GitHub repo is deferred to a separate session — it's cheap (auto-redirect forever) but warrants its own decision.
- The package version (still v0.12.0 on the source tree; this session's bump to v0.12.1 reflects the rename as a separate patch-level touch on the publish-ready package).
- The CLI flag handling, scaffolder behavior, audit script, and template contents (rules, hooks, scripts, lib helpers, docs).

### Verification

`npm run audit:tarball` passes after the rename. `npm pack --dry-run` produces `ulysses-create-workspace-0.12.1.tgz` (npm's scope→slug filename transform). The package is publishable as `@ulysses/create-workspace` whenever the maintainer runs `npm publish --access public` (scoped packages need the explicit `--access public` flag for free public publication).
