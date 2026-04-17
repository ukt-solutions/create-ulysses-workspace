---
branch: chore/scope-rename-to-ulysses
author: myron
date: 2026-04-17
---

## Open Questions

- **GitHub repo rename.** `ukt-solutions/create-ulysses-workspace` → `ukt-solutions/create-workspace` was deferred. Renaming is cheap (GitHub auto-redirects every URL forever) and would align the repo identity with the new package identity. Worth doing before the first `npm publish` — after publishing, the README's documentation links live on npmjs.com and any post-publish repo rename would break them in the published version of the README until the next release.

- **First publish.** `npm publish --access public` is still a deliberate user-triggered action. The scoped package's first publish uses the same one-way-door rule as the unscoped form would have — first install locks the name; even unpublishing within 72h doesn't reclaim it.
