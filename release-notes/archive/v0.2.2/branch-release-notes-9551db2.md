---
branch: chore/design-debt-cleanup
type: fix
author: myron
date: 2026-04-05
---

## Template Design Debt Cleanup

Fixed contradictions between rules and skills in the template, clarified the workspace.json `branch` field, and resolved spec location ambiguity. No new capabilities — all changes are to existing template files.

### Rule-skill separation

Three rules contained workflow instructions that belong in skills. The Commits section of `git-conventions.md` included commit timing policy ("do not commit unless asked") and shared-context bundling instructions — both workflow concerns, not conventions. The `memory-guidance.md` rule contained skill invocation triggers ("suggest /braindump after design decisions", "flag 20+ turns without capture") that are workflow behavior, not memory principles. The `workspace-structure.md` rule included a spec lifecycle instruction ("specs start in inflight, move to worktree") that describes file movement, not structure.

All three rules were trimmed to their convention/principle content. The workflow instructions they contained are already handled by the skills that execute them.

### Override acknowledgments

Three skills — handoff, braindump, and complete-work — auto-commit files without user request, which contradicts git conventions. Each skill's Notes section now explicitly documents this override: handoff and braindump note that auto-committing context files bypasses the "do not commit unless asked" convention (but not the "committed individually" constraint). Complete-work notes that context consumption, cleanup, and release note commits are intentional workflow behavior.

### Branch field clarification

The `start-work` and `complete-work` skills used `{default-branch}` as an undefined placeholder in git commands. Both now explicitly reference `repos.{repo}.branch` from workspace.json, closing the gap between what's declared in config and what skills actually use.
