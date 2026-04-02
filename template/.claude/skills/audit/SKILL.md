---
name: audit
description: Check context integrity — cross-reference shared-context files, verify paths, detect staleness and contradictions. Run periodically or before /release.
---

# Audit

On-demand integrity check for the workspace's shared knowledge. Like a linter for your context files.

## What It Checks

### 1. Cross-reference consistency
Scan all shared-context files against each other:
- **Stale references** — file A mentions "2 mandatory rules" but there are now 4
- **Path references** — file A mentions `shared-context/myron/inflight/design-foo.md` but that file was moved or deleted
- **Contradictions** — file A says "user-scoped is default" but file B says "root is default"

### 2. Frontmatter integrity
For each shared-context `.md` file:
- Does it have valid frontmatter? (state, lifecycle, type, topic, author, updated)
- Does the `branch` field reference a branch that still exists?
- Does the `repo` field reference a repo in workspace.json?
- Is `lifecycle: active` on a file not updated in 7+ days? (stale candidate)
- Are there `lifecycle: resolved` files that should have been processed by /complete-work?

### 3. Workspace structure
- Does the actual directory layout match what workspace-structure rule describes?
- Does CLAUDE.md reference skills that actually exist in `.claude/skills/`?
- Does CLAUDE.md reference rules that exist?
- Are there `.claude/rules/*.md` files not mentioned in CLAUDE.md? (orphaned rules)
- Does workspace.json reference repos that exist in `repos/`?

### 4. Git state
- Are there worktrees with no recent commits? (orphaned worktrees)
- Are there local branches with no remote tracking? (unpushed work)
- Are there worktrees whose branch has already been merged? (cleanup candidates)
- Is the workspace repo on main or a feature branch? (expected state check)

### 5. Context health metrics
- Total size of `shared-context/locked/` — flag if over 10KB target
- Number of ephemeral files — flag if accumulating without being resolved
- Number of inflight files — flag if orphaned (no active work session)
- Session log stats (if `.claude-scratchpad/session-log.jsonl` exists):
  - Compaction-to-capture ratio
  - Sessions without capture
  - Average session length

## Output Format

Report findings grouped by severity:

```
/audit results:

Issues (3):
  ✗ shared-context/myron/create-claude-workspace.md references branch 
    feature/extended-hooks but that branch was deleted
  ✗ 2 inflight files exist but no active work session (orphaned?)
  ✗ Locked context is 12.3KB (target: <10KB)

Warnings (2):
  ⚠ shared-context/myron/workspace-analytics.md not updated in 8 days
  ⚠ Worktree repos/codeapy___wt-old-feature has no commits in 5 days

OK (4):
  ✓ All CLAUDE.md skill references valid
  ✓ Workspace structure matches rule
  ✓ workspace.json repos all present
  ✓ No frontmatter errors
```

## Flow

1. Scan shared-context/ recursively — read all `.md` files and their frontmatter
2. Read CLAUDE.md — extract skill and rule references
3. Read workspace.json — extract repo manifest
4. Check `.claude/rules/`, `.claude/skills/`, `.claude/agents/` against references
5. Check git state (worktrees, branches, remotes)
6. Read session-log.jsonl if it exists
7. Compile and present findings

## Notes
- Read-only — /audit never modifies files, only reports
- Run before /release to catch drift before it compounds
- Run after long gaps between sessions to surface stale context
- Can be incorporated into a regular workflow: "start of each session, run /audit"
