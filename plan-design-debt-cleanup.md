# Template Design Debt Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix contradictions between rules and skills, clarify the workspace.json `branch` field, and remove spec location ambiguity in the create-claude-workspace template.

**Architecture:** All changes are to markdown template files in `template/.claude/rules/` and `template/.claude/skills/`. No code, no hooks, no CLI changes.

**Tech Stack:** Markdown editing only.

**Worktree:** `repos/create-claude-workspace___wt-design-debt-cleanup/`

---

### Task 1: Remove workflow instructions from rules

Three rules contain workflow instructions that belong in skills. Remove them while keeping the rules coherent.

**Files:**
- Modify: `template/.claude/rules/git-conventions.md`
- Modify: `template/.claude/rules/memory-guidance.md`
- Modify: `template/.claude/rules/workspace-structure.md`

- [ ] **Step 1: Fix git-conventions.md — rewrite Commits section**

Replace the entire `## Commits` section with:

```markdown
## Commits

- Conventional commit format: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- Never amend commits unless explicitly asked
- Never force push unless explicitly asked
```

Removed: "Do not commit unless the user explicitly asks" (workflow policy) and "Shared-context files are always committed individually" (workflow instruction for skills).

- [ ] **Step 2: Fix memory-guidance.md — remove workflow trigger sections**

Remove the `## Context Capture` section (lines 22–27) and `## Session Awareness` section (lines 29–33) entirely.

Also update the opening description from:
```
Guide Claude's auto-memory system and context capture discipline for this workspace.
```
to:
```
Guide Claude's auto-memory system for this workspace.
```

The file should end after the "What NOT to Auto-Remember" list. No trailing sections.

- [ ] **Step 3: Fix workspace-structure.md — remove lifecycle instruction from Rules section**

Remove this line from the `## Rules` section:
```
- Specs and plans start in `shared-context/{user}/inflight/` and move to the worktree when a branch is created
```

The remaining five rules in the section stay unchanged.

- [ ] **Step 4: Commit rule fixes**

```bash
cd repos/create-claude-workspace___wt-design-debt-cleanup
git add template/.claude/rules/git-conventions.md template/.claude/rules/memory-guidance.md template/.claude/rules/workspace-structure.md
git commit -m "fix: remove workflow instructions from template rules

Rules should define conventions and principles, not workflow triggers.
Moved commit timing, context capture prompts, and spec lifecycle
instructions to skill concerns."
```

---

### Task 2: Add override acknowledgments to skills

Three skills auto-commit files or consume context without asking, which contradicts the git-conventions rule (even after Task 1 trims it). Make these overrides explicit.

**Files:**
- Modify: `template/.claude/skills/handoff/SKILL.md`
- Modify: `template/.claude/skills/braindump/SKILL.md`
- Modify: `template/.claude/skills/complete-work/SKILL.md`

- [ ] **Step 1: Add override note to handoff skill**

Add this line to the `## Notes` section at the end of the existing bullet list:

```markdown
- Auto-committing context files is a workflow artifact, not a code commit — this intentionally bypasses normal commit conventions
```

- [ ] **Step 2: Add override note to braindump skill**

Add this line to the `## Notes` section at the end of the existing bullet list:

```markdown
- Auto-committing context files is a workflow artifact, not a code commit — this intentionally bypasses normal commit conventions
```

- [ ] **Step 3: Add override note to complete-work skill**

Add this line to the `## Notes` section at the end of the existing bullet list:

```markdown
- Context consumption, cleanup, and auto-committing release notes are intentional workflow behavior — these bypass normal commit conventions by design
```

- [ ] **Step 4: Commit skill override notes**

```bash
cd repos/create-claude-workspace___wt-design-debt-cleanup
git add template/.claude/skills/handoff/SKILL.md template/.claude/skills/braindump/SKILL.md template/.claude/skills/complete-work/SKILL.md
git commit -m "fix: add override acknowledgments to workflow skills

Handoff, braindump, and complete-work auto-commit files and consume
context without asking. These overrides are now explicitly documented
rather than silently contradicting git-conventions."
```

---

### Task 3: Replace `{default-branch}` with workspace.json lookup

Two skills use `{default-branch}` as a placeholder without specifying where to resolve it. Fix them to explicitly read the `branch` field from workspace.json.

**Files:**
- Modify: `template/.claude/skills/start-work/SKILL.md`
- Modify: `template/.claude/skills/complete-work/SKILL.md`

- [ ] **Step 1: Fix start-work skill — branch creation**

In the `### Create branches in both repos` section, replace the project repo block:

```markdown
**Project repo** — branch + worktree (never checkout on the main clone):
```bash
cd repos/{repo}
git fetch origin
git branch {branch-name} origin/{default-branch}
```
```

with:

```markdown
**Project repo** — branch + worktree (never checkout on the main clone):
```bash
# Read the repo's branch from workspace.json (repos.{repo}.branch)
cd repos/{repo}
git fetch origin
git branch {branch-name} origin/{repo-branch}
```
```

- [ ] **Step 2: Fix complete-work skill — rebase command**

In `### Step 2: Rebase project repo`, replace:

```markdown
```bash
cd repos/{repo}___wt-{branch-slug}
git fetch origin
git rebase origin/{default-branch}
```
```

with:

```markdown
```bash
# {repo-branch} = repos.{repo}.branch from workspace.json
cd repos/{repo}___wt-{branch-slug}
git fetch origin
git rebase origin/{repo-branch}
```
```

- [ ] **Step 3: Fix complete-work skill — branch log**

In `### Step 4: Gather source material`, under "Branch commit log", replace:

```markdown
```bash
git log origin/{default-branch}..HEAD --oneline
```
```

with:

```markdown
```bash
git log origin/{repo-branch}..HEAD --oneline
```
```

- [ ] **Step 4: Commit branch lookup fixes**

```bash
cd repos/create-claude-workspace___wt-design-debt-cleanup
git add template/.claude/skills/start-work/SKILL.md template/.claude/skills/complete-work/SKILL.md
git commit -m "fix: replace {default-branch} with workspace.json branch lookup

Skills now explicitly reference the repos.{repo}.branch field from
workspace.json instead of using an undefined {default-branch} placeholder."
```
