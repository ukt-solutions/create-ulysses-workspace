---
branch: feature/polish-and-publish
author: myron
date: 2026-04-17
---

## Open Questions

- **Scoped vs unscoped npm name.** The package ships with the unscoped name `create-ulysses-workspace` (chosen for the short `npm create ulysses-workspace` discovery channel). An `@ulysses/...` scope was discussed and explicitly deferred — it remains an option until first publish, after which the unscoped name is locked. Worth a final read-through before `npm publish` to confirm the unscoped form is the one to live with.

- **Documented follow-ups from the final code review** (none blocking, all flagged for separate sessions):
  1. Align the post-create banner in `bin/create.mjs:72` with the README's `/workspace-init` then `/start-work` guidance — currently says `/start-work blank`.
  2. Tighten the audit's hooks-count predicate to also exclude `*.test.mjs` files, so future test files in `template/.claude/hooks/` don't inflate the count.
  3. Add a "Requires Node ≥ 20.9" line to the README Quick start so users on older Node versions see the requirement before hitting the runtime error.
  4. Consider excluding `*.test.mjs` from the published tarball — small size win (~26 kB), no downside.
  5. Write `RELEASING.md` (publish-flow doc) before the first `npm publish`, including the first-publish-as-name-squat one-way door.
  6. Decide whether `/build-docs-site` belongs in the workspace's own `CLAUDE.md` — `template/CLAUDE.md.tmpl` includes it but the dogfood workspace's `CLAUDE.md` does not.
