---
branch: chore/design-debt-cleanup
type: chore
author: myron
date: 2026-04-05
---

# Design: Template Design Debt Cleanup (v0.2.2)

Fix contradictions between rules and skills, clarify the workspace.json `branch` field, and remove spec location ambiguity. No new capabilities — all changes are to existing files.

## Changes

### 1. git-conventions.md — Remove workflow policy from Commits section

Remove these two lines:
- "Do not commit unless the user explicitly asks"
- "Shared-context files (handoffs, braindumps) are always committed individually — never bundled with code commits"

Both are workflow instructions that belong in skills, not conventions. Keep commit format, branching, worktrees, and branch maintenance sections unchanged.

### 2. memory-guidance.md — Remove workflow trigger sections

Remove the "Context Capture" section (lines 22-27) and the "Session Awareness" section (lines 29-33) entirely. These contain skill invocation triggers ("suggest /braindump", "flag 20+ turns", "when PreCompact fires") that are workflow behavior, not memory guidance.

Keep the "What to Auto-Remember" and "What NOT to Auto-Remember" sections unchanged.

### 3. workspace-structure.md — Remove file lifecycle instruction

Remove "Specs and plans start in `shared-context/{user}/inflight/` and move to the worktree when a branch is created" from the Rules section. This is file lifecycle, not structure. The decision that specs live in the worktree is correct but belongs in skill instructions, not the structure rule.

Keep the rest of the Rules section unchanged.

### 4. handoff skill — Add override acknowledgment

Add to the Notes section: context files are auto-committed as a workflow artifact, intentionally bypassing normal commit conventions.

### 5. braindump skill — Add override acknowledgment

Same as handoff: auto-commit of context files is intentional workflow behavior.

### 6. complete-work skill — Add override acknowledgment

Add to the Notes section: context consumption, cleanup, and auto-committing release notes are intentional workflow behavior.

### 7. start-work skill — Replace `{default-branch}` with workspace.json lookup

Change `origin/{default-branch}` references to explicitly instruct reading the `branch` field from workspace.json for the target repo.

### 8. complete-work skill — Replace `{default-branch}` with workspace.json lookup

Same as start-work: change `origin/{default-branch}` in rebase and log commands to reference the workspace.json `branch` field.

## Scope boundaries

- Only the eight files listed above
- No new rules or skills
- No `.workspace/` restructure
- No changes to hooks, agents, or CLI code
