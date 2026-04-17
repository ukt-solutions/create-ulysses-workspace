---
branch: chore/revert-repo-rename
type: chore
author: myron
date: 2026-04-17
---

## Revert GitHub repo rename — restore `create-ulysses-workspace`

Undoes v0.12.2's GitHub repo rename. The renamed repo `ukt-solutions/create-workspace` was too generic for the org namespace — it monopolized the slot and would make any future workspace scaffolder under `ukt-solutions` (a different product, different framework) feel second-class. Restoring `ukt-solutions/create-ulysses-workspace` keeps every workspace scaffolder product-scoped and equal.

### The asymmetry that bit us

npm has scopes; GitHub orgs are flat. On npm, `@ulysses/create-workspace` reads as "Ulysses' workspace creator" because the scope prefix carries the brand. On GitHub, `ukt-solutions/create-workspace` reads as "ukt-solutions' canonical workspace creator" because the org name doesn't carry product context. Same package name; different namespace semantics.

The right symmetry: keep the npm package as `@ulysses/create-workspace` (scope does the brand work), keep the GitHub repo as `ukt-solutions/create-ulysses-workspace` (repo name carries the product specificity).

### What changed

- GitHub repo renamed back: `ukt-solutions/create-workspace` → `ukt-solutions/create-ulysses-workspace`. GitHub auto-redirects every URL forever.
- `package.json` `repository`/`homepage`/`bugs` URLs reverted to `/create-ulysses-workspace`
- README documentation links (10+ absolute URLs) reverted
- README logo `<img src>` reverted to `raw.githubusercontent.com/ukt-solutions/create-ulysses-workspace/...`
- `workspace.json` `repos.create-ulysses-workspace.remote` reverted (workspace context PR)
- Local git remotes updated in worktree and source clone (`git remote set-url`)

### What stayed the same

- The npm package name (`@ulysses/create-workspace`) — the scope already carries the brand on npm, no reason to rename here.
- The CLI banner, bin name, install commands, and all internal references — those tracked the npm package name, which didn't change.
- The logo and its placement in the README header.
- All other v0.12.2 work.

### Verification

`npm run audit:tarball` passes after the revert. Same 86 files, 104.0 kB tarball.

### Pre-publish state

The package is publishable as `@ulysses/create-workspace` from `https://github.com/ukt-solutions/create-ulysses-workspace`. The asymmetry between scope and repo name is intentional: scope = brand, repo name = product.
