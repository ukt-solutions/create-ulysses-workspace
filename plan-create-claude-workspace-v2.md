# create-claude-workspace Implementation Plan v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the existing template to match spec v2 — add new skills, hooks, rules, update existing skills to v2 behavior, build migration support, write documentation.

**Architecture:** The template core is built (Phases 1-6 from v1 plan). This plan covers what's new in v2 and what existing files need updating. Reference `design-create-claude-workspace-v2.md` for full spec.

**Tech Stack:** Same as v1 — Node.js (scaffolder), Shell scripts (hooks), Markdown (rules, agents, skills, docs).

---

## What's Already Built

From v1 implementation + dogfood session:
- Template directory structure with all .keep files
- CLAUDE.md.tmpl, workspace.json.tmpl, _gitignore
- settings.json with 4 hooks wired
- 8 rules (4 mandatory, 4 .skip)
- 4 hook scripts (session-start, subagent-start, pre-compact, post-compact)
- 3 agent definitions
- 8 skills (setup, start-work, handoff, braindump, pause-work, complete-work, promote, release)
- Scaffolder CLI (bin/create.mjs, lib/prompts.mjs, lib/scaffold.mjs, lib/git.mjs)
- Release notes structure (unreleased/ with branch-release-notes and branch-release-questions)

## What Needs Doing

### Phase A: Update Existing Template Files
Tasks 1-5: Align existing files with spec v2 conventions

### Phase B: New Skills
Tasks 6-8: /sync, /audit, /migrate

### Phase C: Update Existing Skills to v2 Behavior  
Tasks 9-14: Rewrite 6 skills to match v2

### Phase D: New Hooks
Tasks 15-17: Repo-write detection, session logging, stale worktree

### Phase E: New Optional Rules
Tasks 18-21: context-discipline, scope-guard, token-economics, agent-rules

### Phase F: Scaffolder Migration Support
Task 22: --migrate flag

### Phase G: Documentation
Tasks 23-26: All docs

---

## Phase A: Update Existing Template Files

### Task 1: Update CLAUDE.md template

**Files:**
- Modify: `template/CLAUDE.md.tmpl`

- [ ] **Step 1: Update skills list to include /sync and /audit**

Add to the Skills section:
```markdown
- `/sync` — push branches without ceremony
- `/audit` — check context integrity
```

- [ ] **Step 2: Commit**
```bash
git add template/CLAUDE.md.tmpl
git commit -m "feat: add /sync and /audit to CLAUDE.md skills list"
```

---

### Task 2: Update workspace.json template

**Files:**
- Modify: `template/workspace.json.tmpl`

- [ ] **Step 1: Add new fields**

Add `greeting` and `releaseMode` to the workspace section:
```json
{
  "workspace": {
    "name": "{{project-name}}",
    "scratchpadDir": ".claude-scratchpad",
    "worktreeSuffix": "___wt-",
    "sharedContextDir": "shared-context",
    "releaseNotesDir": "release-notes",
    "subagentContextMaxBytes": 10240,
    "greeting": "Welcome back to {{project-name}}.",
    "releaseMode": "per-repo"
  },
  "repos": {}
}
```

- [ ] **Step 2: Commit**
```bash
git commit -m "feat: add greeting and releaseMode to workspace.json template"
```

---

### Task 3: Update workspace-structure rule

**Files:**
- Modify: `template/.claude/rules/workspace-structure.md`

The workspace-structure rule was updated during dogfood but needs the `{user}/inflight/` convention, spec scoping, and the "never change default branch directly" rule. Reference spec v2 §2 and §4 for the full content. Rewrite from scratch per coherent-revisions.

- [ ] **Step 1: Rewrite workspace-structure.md with four-level shared-context, inflight/ongoing, naming conventions, spec scoping, worktree conventions**
- [ ] **Step 2: Commit**
```bash
git commit -m "feat: rewrite workspace-structure rule — full v2 conventions"
```

---

### Task 4: Create shared-context directory structure in template

**Files:**
- Create: `template/shared-context/locked/.keep` (already exists)
- Create: `template/.claude/skills/sync/SKILL.md` (directory)
- Create: `template/.claude/skills/audit/SKILL.md` (directory)

- [ ] **Step 1: Create skill directories**
```bash
mkdir -p template/.claude/skills/sync template/.claude/skills/audit
```

- [ ] **Step 2: Commit**
```bash
git commit -m "chore: add /sync and /audit skill directories"
```

---

### Task 5: Update scaffolder to handle new fields

**Files:**
- Modify: `lib/scaffold.mjs`

- [ ] **Step 1: Update scaffold to handle greeting field in workspace.json**

The template already has the greeting in workspace.json.tmpl. The scaffold function replaces `{{project-name}}` which covers it. Verify this works with the greeting field.

- [ ] **Step 2: Update prompts.mjs to ask about releaseMode for multi-repo workspaces**

Only ask if more than one repo is configured. Default to "per-repo".

- [ ] **Step 3: Commit**
```bash
git commit -m "feat: scaffolder handles greeting and releaseMode"
```

---

## Phase B: New Skills

### Task 6: Write /sync skill

**Files:**
- Create: `template/.claude/skills/sync/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

/sync pushes both workspace and project repo branches without ceremony. No PR, no status change, no forced capture. Handles missing remotes by offering to create them. Optionally offers /braindump or /handoff but doesn't require it.

Reference spec v2 §9 (/sync section) for behavior.

- [ ] **Step 2: Commit**
```bash
git commit -m "feat: add /sync skill — push without ceremony"
```

---

### Task 7: Write /audit skill

**Files:**
- Create: `template/.claude/skills/audit/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

/audit performs on-demand integrity checks:
- Cross-reference shared-context files for contradictions and staleness
- Check memory files against shared-context
- Verify workspace-structure rule matches actual directory layout
- Verify CLAUDE.md references match actual skills/rules
- Check handoff frontmatter (branch, repo) against actual git state
- Report gaps with specific file references

Reference spec v2 §14 for behavior.

- [ ] **Step 2: Commit**
```bash
git commit -m "feat: add /audit skill — context integrity checking"
```

---

### Task 8: Write /migrate skill

**Files:**
- Create: `template/.claude/skills/migrate/SKILL.md`
- Create directory: `template/.claude/skills/migrate/`

- [ ] **Step 1: Create skill directory**
```bash
mkdir -p template/.claude/skills/migrate
```

- [ ] **Step 2: Write SKILL.md**

/migrate converts an existing workspace or updates a workspace from a newer template version. Interactive flow:
1. Detect existing workspace structure
2. Map existing directories to template conventions
3. Ask what to migrate (rules, hooks, skills, agents, context)
4. Create missing directories and files
5. Offer to move existing context files into shared-context/
6. Update CLAUDE.md and workspace.json

Reference spec v2 §16 (migration support) for behavior.

- [ ] **Step 3: Add to CLAUDE.md template skills list**
- [ ] **Step 4: Commit**
```bash
git commit -m "feat: add /migrate skill — workspace conversion and template updates"
```

---

## Phase C: Update Existing Skills to v2 Behavior

### Task 9: Rewrite /start-work skill

**Files:**
- Modify: `template/.claude/skills/start-work/SKILL.md`

Key v2 changes:
- Branch BOTH project repo (with worktree) AND workspace repo
- Same branch name in both for traceability
- Create `{user}/inflight/` directory for the work session
- Support retroactive formalization (called mid-session, catches up)
- Check for stale worktrees when creating new ones

Reference spec v2 §9 (/start-work) and §11 (workspace branching).

- [ ] **Step 1: Rewrite SKILL.md from scratch**
- [ ] **Step 2: Commit**
```bash
git commit -m "feat: rewrite /start-work — dual-repo branching, retroactive support, stale worktree check"
```

---

### Task 10: Rewrite /complete-work skill

**Files:**
- Modify: `template/.claude/skills/complete-work/SKILL.md`

Key v2 changes:
- Handle BOTH project repo and workspace repo
- Process inflight/ (resolve handoffs, move braindumps to ongoing, consume specs/plans)
- Distinguish branch-scoped vs project-scoped specs
- Formally read all three sources (spec + handoffs + commits) before synthesizing
- Create branch-release-notes per repo (not workspace)
- PR both repos
- Offer worktree cleanup with stale worktree scan
- Handle case where changes were made without formal work session (accept/stash/delegate/revert)

Reference spec v2 §9 (/complete-work) and §12 (work session detection).

- [ ] **Step 1: Rewrite SKILL.md from scratch**
- [ ] **Step 2: Commit**
```bash
git commit -m "feat: rewrite /complete-work — dual-repo handling, inflight processing, formal synthesis"
```

---

### Task 11: Rewrite /pause-work skill

**Files:**
- Modify: `template/.claude/skills/pause-work/SKILL.md`

Key v2 changes:
- Push BOTH repos
- Draft PR for project repo branch
- Handle missing remotes (offer to create)
- Mark inflight context as paused

Reference spec v2 §9 (/pause-work) and §11 (no-remote handling).

- [ ] **Step 1: Rewrite SKILL.md from scratch**
- [ ] **Step 2: Commit**
```bash
git commit -m "feat: rewrite /pause-work — dual-repo push, no-remote handling"
```

---

### Task 12: Rewrite /release skill

**Files:**
- Modify: `template/.claude/skills/release/SKILL.md`

Key v2 changes:
- Target repos, not workspace
- Per-repo by default (controlled by workspace.json releaseMode)
- Multi-repo support: ask which repo, or process all
- Workspace context synthesis happens alongside but doesn't produce workspace version
- Handle project-scoped specs (consume at release time, not branch time)
- Archive unreleased files after combining

Reference spec v2 §9 (/release) and §13 (release process).

- [ ] **Step 1: Rewrite SKILL.md from scratch**
- [ ] **Step 2: Commit**
```bash
git commit -m "feat: rewrite /release — per-repo targeting, workspace context synthesis"
```

---

### Task 13: Update /handoff skill

**Files:**
- Modify: `template/.claude/skills/handoff/SKILL.md`

Key v2 changes:
- User-scoped default (not root)
- Capture-time cross-check: after writing, scan existing files for staleness/overlap
- Side handoff support (unrelated to current work)

- [ ] **Step 1: Rewrite SKILL.md from scratch**
- [ ] **Step 2: Commit**
```bash
git commit -m "feat: rewrite /handoff — user-scoped default, capture-time cross-check"
```

---

### Task 14: Update /braindump skill

**Files:**
- Modify: `template/.claude/skills/braindump/SKILL.md`

Key v2 changes:
- User-scoped default
- `/braindump side {name}` — explicitly marks as unrelated to current work, skips branch/repo context questions, defaults to user-scoped or local-only
- Capture-time cross-check

- [ ] **Step 1: Rewrite SKILL.md from scratch**
- [ ] **Step 2: Commit**
```bash
git commit -m "feat: rewrite /braindump — user-scoped default, side braindump, cross-check"
```

---

## Phase D: New Hooks

### Task 15: Write repo-write detection hook

**Files:**
- Create: `template/.claude/hooks/repo-write-detection.sh`
- Modify: `template/.claude/settings.json`

- [ ] **Step 1: Write repo-write-detection.sh**

PreToolUse hook that detects writes targeting `repos/` without an active work session. Checks:
- Is the tool Bash, Edit, or Write?
- Does the target path contain `repos/`?
- Is there an active worktree for that repo (not on default branch)?
- If no active work session: return warning in additionalContext suggesting /start-work

- [ ] **Step 2: Wire into settings.json as PreToolUse hook**
- [ ] **Step 3: Make executable**
- [ ] **Step 4: Commit**
```bash
git commit -m "feat: add repo-write detection hook — warn on changes without work session"
```

---

### Task 16: Write session logging hook

**Files:**
- Create: `template/.claude/hooks/session-end.sh`
- Modify: `template/.claude/settings.json`

- [ ] **Step 1: Write session-end.sh**

SessionEnd hook that appends summary to `.claude-scratchpad/session-log.jsonl`:
```json
{"event": "session_end", "date": "ISO8601", "user": "name", "reason": "logout|clear|other"}
```

- [ ] **Step 2: Wire into settings.json**
- [ ] **Step 3: Make executable**
- [ ] **Step 4: Commit**
```bash
git commit -m "feat: add session logging hook — append to session-log.jsonl"
```

---

### Task 17: Write stale worktree detection hook

**Files:**
- Create: `template/.claude/hooks/worktree-create.sh`
- Modify: `template/.claude/settings.json`

- [ ] **Step 1: Write worktree-create.sh**

WorktreeCreate hook that scans for existing worktrees and flags stale ones (no recent commits, no open PR) in additionalContext.

- [ ] **Step 2: Wire into settings.json**
- [ ] **Step 3: Make executable**
- [ ] **Step 4: Commit**
```bash
git commit -m "feat: add stale worktree detection hook"
```

---

## Phase E: New Optional Rules

### Task 18: Write context-discipline rule

**Files:**
- Create: `template/.claude/rules/context-discipline.md.skip`

- [ ] **Step 1: Write rule**

Heavily push handoffs and braindumps at natural breakpoints. Suggest capture after design decisions, topic switches, task completions. Flag long sessions without capture.

- [ ] **Step 2: Commit**
```bash
git commit -m "feat: add context-discipline rule (.skip)"
```

---

### Task 19: Write scope-guard rule

**Files:**
- Create: `template/.claude/rules/scope-guard.md.skip`

- [ ] **Step 1: Write rule**

Detect scope creep. Flag when tasks grow beyond original description. Suggest splitting. Enforce YAGNI.

- [ ] **Step 2: Commit**
```bash
git commit -m "feat: add scope-guard rule (.skip)"
```

---

### Task 20: Write token-economics rule

**Files:**
- Create: `template/.claude/rules/token-economics.md.skip`

- [ ] **Step 1: Write rule**

Token-aware behavior: suggest appropriate model/effort for tasks, flag context waste, prefer efficient approaches.

- [ ] **Step 2: Commit**
```bash
git commit -m "feat: add token-economics rule (.skip)"
```

---

### Task 21: Write agent-rules rule

**Files:**
- Create: `template/.claude/rules/agent-rules.md.skip`

- [ ] **Step 1: Write rule**

Agent-specific behavior: follow coherent-revisions, report escalation status, don't read plan files, reviewers stay within diff scope.

- [ ] **Step 2: Commit**
```bash
git commit -m "feat: add agent-rules rule (.skip)"
```

---

## Phase F: Scaffolder Migration Support

### Task 22: Add --migrate flag to scaffolder

**Files:**
- Modify: `bin/create.mjs`
- Create: `lib/migrate.mjs`

- [ ] **Step 1: Write lib/migrate.mjs**

Migration module:
1. Detect existing workspace structure (look for CLAUDE.md, .claude/, repos/)
2. Identify what exists vs what's missing
3. Interactively ask what to set up (rules, hooks, skills, agents, shared-context structure)
4. Create missing directories and files without overwriting existing ones
5. Update CLAUDE.md and workspace.json if needed
6. Offer to move existing context files into shared-context/

- [ ] **Step 2: Update bin/create.mjs to accept --migrate flag**

Check `process.argv` for `--migrate`. If present, run migrate flow instead of scaffold flow.

- [ ] **Step 3: Test migration on a mock existing workspace**
- [ ] **Step 4: Commit**
```bash
git commit -m "feat: add --migrate flag for converting existing workspaces"
```

---

## Phase G: Documentation

### Task 23: Write core concept docs

**Files:**
- Create: `template/docs/getting-started.md`
- Create: `template/docs/concepts/workspace-structure.md`
- Create: `template/docs/concepts/file-conventions.md`
- Create: `template/docs/concepts/knowledge-lifecycle.md`
- Create: `template/docs/concepts/three-layers.md`

Reference spec v2 §§1-4 and documentation-seeds braindump for content and phrasings.

- [ ] **Step 1-5: Write each doc**
- [ ] **Step 6: Commit**
```bash
git commit -m "docs: add core concept documentation"
```

---

### Task 24: Write skill documentation

**Files:**
- Create: `template/docs/skills/{setup,start-work,handoff,braindump,pause-work,complete-work,promote,release,sync,audit}.md`

10 skill docs. Each covers: what it does, parameters, step-by-step walkthrough, related skills, tips.

- [ ] **Step 1-10: Write each doc**
- [ ] **Step 11: Commit**
```bash
git commit -m "docs: add skill documentation for all 10 skills"
```

---

### Task 25: Write agent and configuration docs

**Files:**
- Create: `template/docs/agents/{overview,researcher,implementer,reviewer,creating-custom-agents}.md`
- Create: `template/docs/configuration/{workspace-json,settings-json,rules,hooks}.md`

- [ ] **Steps 1-9: Write each doc**
- [ ] **Step 10: Commit**
```bash
git commit -m "docs: add agent and configuration documentation"
```

---

### Task 26: Write guides and reference docs

**Files:**
- Create: `template/docs/guides/{team-onboarding,solo-workflow,migrating-from-notion,customizing-the-template,behavioral-patterns}.md`
- Create: `template/docs/reference/{file-format-reference,workspace-json-schema}.md`

Note: `behavioral-patterns.md` is new — covers "how to hold the tool" from documentation-seeds braindump.

- [ ] **Steps 1-7: Write each doc**
- [ ] **Step 8: Commit**
```bash
git commit -m "docs: add guides and reference documentation"
```

---

## Self-Review

**Spec v2 coverage:** All 19 sections have corresponding tasks:
- §1-2 → Tasks 1-4 (template updates)
- §3 → Already implemented (file convention)
- §4 → Task 3 (workspace-structure rule) + Tasks 13-14 (skill updates)
- §5-6 → Tasks 1-2 (CLAUDE.md + workspace.json)
- §7 → Tasks 15-17 (new hooks)
- §8 → Tasks 18-21 (new rules)
- §9 → Tasks 6-14 (new + updated skills)
- §10 → Already implemented (agents)
- §11 → Tasks 9-12 (workspace branching via skill updates)
- §12 → Task 15 (repo-write detection)
- §13 → Task 12 (/release rewrite)
- §14 → Task 7 (/audit skill)
- §15 → Task 16 (session logging)
- §16 → Task 22 (scaffolder migration)
- §17 → Already implemented (.gitignore)
- §18 → Tasks 23-26 (documentation)
- §19 → Open questions in branch-release-questions file

**Task count:** 26 tasks across 7 phases
**Already built:** Template core, scaffolder, 8 skills, 4 hooks, 8 rules, 3 agents
**New:** 3 skills, 3 hooks, 4 rules, migration module, 20+ docs
**Updated:** 6 skills, 3 template files, scaffolder
