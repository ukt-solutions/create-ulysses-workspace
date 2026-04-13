---
branch: feature/docs-site-skill
author: myron
date: 2026-04-13
---

## Open Questions

- **End-to-end testing.** The skill has not been run on a real project from Phase 0 through Phase 8. The grep scripts were smoke-tested individually and produced expected output, but the full orchestration flow needs a real Docusaurus target, which doesn't exist in any of this workspace's repos. First real use will surface anything the design missed.
- **Bulk fill migration smoke test.** The Python migration script handles three known regression cases by design but was not tested against a fixture. The first real use against a chapter components directory may surface edge cases in the JSX parsing.
- **Skill directory convention.** This is the first skill with a sub-directory structure. If the pattern works in practice, other complex skills (workspace-init at 464 lines, complete-work at 282 lines) could adopt it. Decision deferred until there's evidence from real use.
- **Existing docs site handling.** If a user points the skill at an existing Docusaurus site, the skill currently scaffolds from scratch. A future enhancement could read the existing config and structure as a starting point. Not required for v1.
- **Chapter 1 inversion override.** The skill writes Chapter 1 last by default (technical-writing convention). No user-facing override was added. If users prefer writing in order, they'd need to manually skip the inversion.
