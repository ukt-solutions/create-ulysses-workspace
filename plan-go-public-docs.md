# Go Public Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write 11 textbook chapters and 3 audience-specific guides that document every concept in a claude-workspace, enabling someone who isn't the author to install and use the product.

**Architecture:** Each doc is a standalone markdown file in `template/docs/`. Chapters follow a narrative arc (Concepts → Toolkit → Lifecycle → Practice). Guides are warm onboarding ramps that point into chapters. Two distinct writing voices: authoritative textbook for chapters, hand-holding walkthrough for guides.

**Tech Stack:** Markdown files in `template/docs/chapters/` and `template/docs/guides/`.

**Important context for all tasks:**

The spec is at `design-go-public-docs.md` in the project worktree root. Read it before starting any task.

Writing conventions (from the spec):
- **Chapters:** Authoritative, confident, direct. Spring's concept-first structure, Stripe's voice, Next.js clarity. Opens with 2-3 sentence summary. Inline examples. Closes with Key Takeaways (3-5 bullets). ~1500-2000 words. Cross-references via relative links.
- **Guides:** Warm, approachable, hand-holding. "You" oriented. Step-by-step with visible results. ~800-1200 words. Ends by pointing to specific chapters.

Source material lives in:
- `shared-context/documentation-seeds.md` (in the workspace worktree at `repos/go-public-docs___wt-workspace/`)
- Template files: `template/.claude/skills/`, `template/.claude/rules/`, `template/.claude/hooks/`, `template/.claude/agents/`, `template/.claude/scripts/`
- `template/CLAUDE.md.tmpl` and `template/workspace.json.tmpl`

All files are created in the project worktree at: `template/docs/chapters/` and `template/docs/guides/`

---

### Task 1: Create docs directory structure

**Files:**
- Create: `template/docs/chapters/` (directory)
- Create: `template/docs/guides/` (directory)

- [ ] **Step 1: Create directories**

```bash
mkdir -p template/docs/chapters template/docs/guides
```

- [ ] **Step 2: Commit**

```bash
git add template/docs/
git commit -m "docs: scaffold docs directory structure"
```

---

### Task 2: Chapter 01 — What Is a Workspace

**Files:**
- Create: `template/docs/chapters/01-what-is-a-workspace.md`

**Source material to read:**
- `template/.claude/rules/workspace-structure.md` — directory layout, naming conventions, rules
- `template/CLAUDE.md.tmpl` — the entry point structure
- `template/workspace.json.tmpl` — configuration shape
- `shared-context/documentation-seeds.md` — "Three layers," "Convention over configuration," "Scratchpad vs shared-context"

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. What a workspace is — a launcher root with conventions, not a framework. The root stays on main.
2. The three layers: template (upstream, generic) → team workspace (project-specific, committed) → personal (gitignored). How they map to solo vs team use.
3. Directory layout — repos/, shared-context/, .claude-scratchpad/, .claude/. What each holds and whether it's tracked.
4. workspace.json — the configuration file. Repos manifest, settings.
5. How repos relate to the workspace — cloned into repos/, worktrees created for work sessions.
6. Convention over configuration — naming conventions do the heavy lifting. No runtime, no framework.

Open with a 2-3 sentence summary. Close with Key Takeaways (3-5 bullets). Use inline examples (e.g., show a workspace directory listing). ~1500-2000 words. Cross-reference Chapter 2 (work sessions) and Chapter 3 (shared context) where naturally motivated.

- [ ] **Step 3: Review against spec**

Verify: authoritative voice, inline examples, opens with summary, closes with Key Takeaways, ~1500-2000 words, cross-references use relative links like `[work sessions](02-work-sessions.md)`.

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/01-what-is-a-workspace.md
git commit -m "docs: chapter 01 — what is a workspace"
```

---

### Task 3: Chapter 02 — Work Sessions

**Files:**
- Create: `template/docs/chapters/02-work-sessions.md`

**Source material to read:**
- `template/.claude/skills/start-work/SKILL.md` — session creation, resume, retroactive
- `template/.claude/skills/complete-work/SKILL.md` — session completion flow
- `template/.claude/skills/pause-work/SKILL.md` — session pausing
- `template/.claude/scripts/create-work-session.mjs` — what the script creates
- `template/.claude/rules/git-conventions.md` — branching and worktree conventions
- `shared-context/documentation-seeds.md` — "Terminology: work session not chat session"

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. What a work session is — the unit of tracked work. One branch, one lifecycle.
2. The lifecycle: /start-work → work → /pause-work or /complete-work. How /sync-work fits (backup, not lifecycle).
3. Session markers — `.claude-scratchpad/.work-session-{name}.json`. What they track, how they persist across chats.
4. Worktrees — workspace worktree + project worktree(s). The `{session}___wt-{type}` naming convention. Why worktrees instead of branch switching.
5. Multi-repo sessions — same branch across N repos + workspace. Adding a repo mid-session.
6. Parallel sessions — each session in its own terminal, its own worktrees.
7. Chat session vs work session — multiple chats can contribute to one work session. History reconstruction on resume.

Inline example: show what `repos/` looks like with two parallel sessions active. ~1500-2000 words.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/02-work-sessions.md
git commit -m "docs: chapter 02 — work sessions"
```

---

### Task 4: Chapter 03 — Shared Context

**Files:**
- Create: `template/docs/chapters/03-shared-context.md`

**Source material to read:**
- `template/.claude/rules/workspace-structure.md` — shared context levels, naming conventions
- `template/.claude/skills/handoff/SKILL.md` — how handoffs create shared context
- `template/.claude/skills/braindump/SKILL.md` — how braindumps create shared context
- `template/.claude/skills/aside/SKILL.md` — drive-by idea capture
- `template/.claude/skills/promote/SKILL.md` — ephemeral → locked promotion
- `shared-context/documentation-seeds.md` — "Three-level shared-context convention," "Handoffs as working documents," "Anti-pattern: one giant handoff," "Post-release ephemeral lifecycle," "Ephemeral locked context — front-of-mind temporaries"

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. What shared context is — the workspace's memory system. Everything Claude needs is in the file system; everything a team shares is in git.
2. Three levels: locked/ (team truths, always loaded, injected into subagents), root (team-visible ephemerals), {user}/ (personal working context). User-scoped is the default.
3. Inflight trackers — per work session, in `{user}/inflight/`. Created by /start-work, consumed by /complete-work.
4. Frontmatter conventions — state, lifecycle, type, topic, author, updated. What each field means.
5. How context gets created — /handoff for workstream state, /braindump for discussion/reasoning, /aside for drive-by ideas. Introduce these as the capture patterns (Chapter 6 covers full skill mechanics).
6. The promotion lifecycle — ephemeral → locked via /promote or /release. When to promote. The <10KB target for locked.
7. The ephemeral locked pattern — `local-only-*` files in locked/ as temporary front-of-mind aids. Locked ≠ permanent; locked = positioned for maximum attention.

~1500-2000 words. Cross-reference Chapter 6 (skills) for full capture skill details.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/03-shared-context.md
git commit -m "docs: chapter 03 — shared context"
```

---

### Task 5: Chapter 04 — CLAUDE.md

**Files:**
- Create: `template/docs/chapters/04-claude-md.md`

**Source material to read:**
- `template/CLAUDE.md.tmpl` — the actual template
- `shared-context/documentation-seeds.md` — "Context window footprint," "SubagentStart hook solves context loss structurally"

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. What CLAUDE.md is — the entry point that Claude reads on every turn. The most important file in the workspace.
2. Structure walkthrough — Quick Reference, @workspace.json, @shared-context/locked/, Skills list. What each section does.
3. The @-reference pattern — how `@workspace.json` and `@shared-context/locked/` pull content into Claude's context. What "always loaded" means.
4. What Claude sees — CLAUDE.md content lands in the system prompt area. Rules load alongside it. Skills load on invocation. The loading order: CLAUDE.md → workspace.json → rules/ → locked context.
5. Context window cost — the workspace template costs ~1,547 tokens always-loaded. That's ~0.15% of Opus context. Why keeping it lean matters.
6. Customizing CLAUDE.md — adding project-specific quick reference, additional @-references, custom skill documentation.

Show the full CLAUDE.md.tmpl as an inline example. ~1500-2000 words.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/04-claude-md.md
git commit -m "docs: chapter 04 — CLAUDE.md"
```

---

### Task 6: Chapter 05 — Rules

**Files:**
- Create: `template/docs/chapters/05-rules.md`

**Source material to read:**
- All files in `template/.claude/rules/` — read each mandatory and optional rule
- `shared-context/documentation-seeds.md` — "Three-state file convention"

- [ ] **Step 1: Read all source material listed above**

Read every `.md` and `.md.skip` file in `template/.claude/rules/`.

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. What rules are — markdown files in `.claude/rules/` that define behavioral constraints. Claude reads them every turn.
2. Mandatory rules (5) — coherent-revisions, git-conventions, honest-pushback, workspace-structure, memory-guidance. One paragraph each explaining what it does and why it's mandatory.
3. Optional rules (6) — the .skip files. cloud-infrastructure, superpowers-workflow, documentation, scope-guard, token-economics, agent-rules. Brief description of each.
4. The .skip activation pattern — `.md` = active and shared, `.md.skip` = available but inactive, `local-only-*` = active and personal. Drop `.skip` to activate. This convention applies universally.
5. Loading order and priority — user instructions (CLAUDE.md) > rules > default behavior. How rules and skills interact: rules set constraints, skills define workflows. Skills can override rules where the skill says so.
6. Writing custom rules — where to put them, how to structure them, when to use .skip for optional ones.

~1500-2000 words. Inline example: show the rules/ directory listing with .skip files visible.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/05-rules.md
git commit -m "docs: chapter 05 — rules"
```

---

### Task 7: Chapter 06 — Skills

**Files:**
- Create: `template/docs/chapters/06-skills.md`

**Source material to read:**
- All `SKILL.md` files in `template/.claude/skills/*/` — read each one
- `template/CLAUDE.md.tmpl` — skills list as documented for users

- [ ] **Step 1: Read all source material listed above**

Read every SKILL.md file in the template's skills directory (13 skills).

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. What skills are — workflow commands invoked via `/skill-name`. Markdown instruction files that Claude follows. They live in `.claude/skills/{name}/SKILL.md`.
2. How skills work — invoked by the user, loaded on demand (not always-loaded like rules). Each skill is a self-contained workflow definition.
3. Capture skills group: /braindump (capture discussion/reasoning), /handoff (save workstream state), /aside (drive-by idea capture, dispatches background researcher). When to use each.
4. Lifecycle skills group: /start-work (begin/resume session), /pause-work (suspend with draft PRs), /complete-work (finalize with release notes and real PRs), /sync-work (push without ceremony). The workflow chain.
5. Admin skills group: /promote (ephemeral → locked), /release (combine unreleased notes into versioned doc), /maintenance (audit and cleanup), /setup (first-time initialization), /workspace-init (populate shared context), /workspace-update (apply template updates).
6. How skills chain together — the natural workflow: /start-work → work → /braindump or /handoff as needed → /complete-work → /release. Show the flow.

Each skill gets: what it does, when to use it, what it produces. ~1500-2000 words.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/06-skills.md
git commit -m "docs: chapter 06 — skills"
```

---

### Task 8: Chapter 07 — Hooks and Scripts

**Files:**
- Create: `template/docs/chapters/07-hooks-and-scripts.md`

**Source material to read:**
- All `.mjs` files in `template/.claude/hooks/` (except `_utils.mjs`) — read each hook
- All `.mjs` files in `template/.claude/scripts/` — read each script
- `shared-context/documentation-seeds.md` — "Two surgical hooks, not a framework of automation," "PreCompact as capture trigger," "SubagentStart hook solves context loss structurally"

- [ ] **Step 1: Read all source material listed above**

Read every hook and script file.

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. What hooks are — Node.js scripts that fire on Claude Code events. Automatic, invisible, always running. "Two surgical hooks, not a framework of automation."
2. The hook model — hooks respond to events (SessionStart, SessionEnd, PreCompact, PostCompact, PreToolUse, SubagentStart). They can return `additionalContext` to inject information into Claude's context.
3. Each hook explained:
   - session-start: surfaces active sessions and handoffs on conversation start
   - session-end: records chat session end time in the marker
   - pre-compact: suggests capture before context compression
   - post-compact: reminds that context was lost
   - subagent-start: injects locked context into subagents
   - repo-write-detection (PreToolUse): enforces worktree write restrictions, detects out-of-session repo writes
   - worktree-create: fires when a worktree is created
   - workspace-update-check: checks for pending template updates
4. What scripts are — helper scripts that consolidate mechanical git sequences. Called by skills, not by users directly.
5. Each script: create-work-session.mjs, cleanup-work-session.mjs, add-repo-to-session.mjs. What each does, what arguments it takes.
6. How hooks and scripts work together — hooks detect conditions, skills make decisions, scripts execute mechanical sequences.

~1500-2000 words.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/07-hooks-and-scripts.md
git commit -m "docs: chapter 07 — hooks and scripts"
```

---

### Task 9: Chapter 08 — Agents

**Files:**
- Create: `template/docs/chapters/08-agents.md`

**Source material to read:**
- All `.md` files in `template/.claude/agents/` — read each agent definition
- `template/.claude/hooks/subagent-start.mjs` — the context injection hook
- `template/.claude/skills/aside/SKILL.md` — how /aside dispatches aside-researcher

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. What agents are — markdown definitions in `.claude/agents/` that describe specialized subagent roles. Skills dispatch them for focused work.
2. Built-in agents: researcher (read-only exploration), implementer (focused execution in worktrees), reviewer (code review), aside-researcher (background idea expansion for /aside).
3. The subagent context problem — subagents get zero conversation history. They start cold.
4. Context injection — the SubagentStart hook automatically injects locked context into every subagent. Team knowledge arrives without anyone remembering to paste it.
5. How skills dispatch agents — example: /aside dispatches aside-researcher with the user's idea. The agent runs in the background, writes its findings to shared context.
6. Writing custom agents — where to put them, how to structure the definition, how to reference them from skills.

This is likely the shortest chapter (~1200-1500 words) since agents are simpler than the other concepts.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/08-agents.md
git commit -m "docs: chapter 08 — agents"
```

---

### Task 10: Chapter 09 — The Release Cycle

**Files:**
- Create: `template/docs/chapters/09-the-release-cycle.md`

**Source material to read:**
- `template/.claude/skills/complete-work/SKILL.md` — release notes synthesis
- `template/.claude/skills/release/SKILL.md` — version release flow
- `shared-context/documentation-seeds.md` — "Post-release ephemeral lifecycle," "Specs are ephemeral"
- A few example release note files in `release-notes/` for format reference

- [ ] **Step 1: Read all source material listed above**

Read the complete-work and release skill files. Read 1-2 example release notes from `release-notes/archive/` for format reference.

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. The release notes pipeline — branch work produces specs/plans/commits → /complete-work synthesizes into `release-notes/unreleased/` → /release combines into a versioned document → archive.
2. How /complete-work synthesizes — reads inflight tracker, specs, plans, handoffs, and commit log. Produces two files: branch-release-notes and branch-release-questions.
3. How /release works — reads all unreleased notes, synthesizes into a versioned release document, archives the branch notes, updates shared context.
4. The ephemeral cleanup pattern — what happens to shared context after release. Ephemerals either get synthesized into locked (team truth), moved to user-scoped (personal reference), or discarded.
5. Version numbering — fixes → patch, features → minor, breaking → major. Assigned at release time, not pre-planned.
6. Specs are ephemeral — they live in the worktree during development, get consumed into release notes, then are removed. The release note is the surviving artifact.

Show an example release notes file (frontmatter + content). ~1500-2000 words.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/09-the-release-cycle.md
git commit -m "docs: chapter 09 — the release cycle"
```

---

### Task 11: Chapter 10 — Installation and Upgrades

**Files:**
- Create: `template/docs/chapters/10-installation-and-upgrades.md`

**Source material to read:**
- `bin/create.mjs` — the CLI entry point
- `lib/init.mjs` — the --init flow
- `lib/upgrade.mjs` — the --upgrade flow
- `template/.claude/skills/workspace-update/SKILL.md` — the interactive update skill
- `template/.claude/skills/setup/SKILL.md` — first-time setup
- `template/.claude/hooks/workspace-update-check.mjs` — update detection
- `template/workspace.json.tmpl` — templateVersion field

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the chapter**

Cover these concepts in this order:
1. Installing — how to scaffold a new workspace with the CLI. What `--init` does: creates the directory structure, copies template files, initializes git.
2. First-time setup — running /setup after scaffolding. Cloning repos, activating optional rules, configuring user identity.
3. Adding repos — editing workspace.json to add repos, cloning them into repos/.
4. Template versioning — the `templateVersion` field in workspace.json. How it tracks which template version the workspace was created from.
5. Upgrading — how `--upgrade` works. The CLI stages a payload to `.workspace-update/`. The /workspace-update skill applies it interactively with maintenance audits before and after.
6. The workspace-update-check hook — detects pending updates on each tool call. Nudges the user to run /workspace-update.
7. Staying current — when to upgrade, what changes between versions, how to handle customizations.

Show the install command and a sample workspace.json. ~1500-2000 words.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/10-installation-and-upgrades.md
git commit -m "docs: chapter 10 — installation and upgrades"
```

---

### Task 12: Chapter 11 — Behavioral Patterns

**Files:**
- Create: `template/docs/chapters/11-behavioral-patterns.md`

**Source material to read:**
- `shared-context/documentation-seeds.md` — the entire "Behavioral Patterns" section and "Phrasings Worth Preserving"

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the chapter**

This chapter is different from the others — it's prescriptive rather than descriptive. Each pattern gets: the rule, why it matters, what goes wrong if you skip it.

Cover these patterns:
1. One topic, one file — don't let handoffs become grab-bags. Different topic, different lifecycle, different audience = different file.
2. Name before writing — the name forces you to identify the single topic. If you can't name it cleanly, you're conflating topics.
3. Rewrite, don't append — when updating across sessions, rewrite as a fresh snapshot. Coherent revisions in daily practice.
4. Braindump when you hear "we decided..." — that phrase is the signal that a decision worth capturing just happened.
5. Keep locked context lean — target <10KB. Every locked file costs tokens on every turn. The /release synthesis cycle is the natural pressure valve.
6. Clean up your ephemerals — after release, promote, localize, or delete. Don't let shared context accumulate indefinitely.
7. Don't skip capture on discussion sessions — no branch doesn't mean no value. Architecture talk for 30 minutes → /braindump.
8. One chat session, one work session — finish a branch, exit, start fresh. Chaining degrades context.
9. Let PreCompact nudge you — when the hook fires, stop and capture. Context you lose to compaction is gone.

Open with "These are not rules Claude enforces — they're practices that make the conventions work. The workspace gives you the tools; these patterns tell you when to reach for them." Close with Key Takeaways. ~1500-2000 words.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/chapters/11-behavioral-patterns.md
git commit -m "docs: chapter 11 — behavioral patterns"
```

---

### Task 13: Solo Developer Guide

**Files:**
- Create: `template/docs/guides/solo-developer.md`

**Source material to read:**
- `design-go-public-docs.md` — guide spec (Solo Developer section)
- `template/docs/chapters/01-what-is-a-workspace.md` — for cross-references
- `template/docs/chapters/02-work-sessions.md` — for cross-references
- `template/docs/chapters/10-installation-and-upgrades.md` — for install steps

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the guide**

Warm, hand-holding tone. "You" oriented throughout. Walk through:

1. "You use Claude Code for your projects. This guide adds structure." — 2-3 sentences of motivation.
2. Install and scaffold a workspace (show the exact commands).
3. Add your first repo to workspace.json and clone it.
4. Run /setup.
5. Start your first work session with /start-work. Show what happens — worktrees created, marker written.
6. Make a small change, commit it.
7. Complete the session with /complete-work. Show the PR and release notes.
8. "You just did a full cycle." — summarize what happened.
9. Point to Chapters 1, 2, 10 for deeper understanding.

~800-1200 words. Every step has a concrete command or visible result.

- [ ] **Step 3: Review against spec**

Verify: warm tone, "you" oriented, step-by-step, ends pointing to chapters, ~800-1200 words.

- [ ] **Step 4: Commit**

```bash
git add template/docs/guides/solo-developer.md
git commit -m "docs: solo developer guide"
```

---

### Task 14: Team Lead Guide

**Files:**
- Create: `template/docs/guides/team-lead.md`

**Source material to read:**
- `design-go-public-docs.md` — guide spec (Team Lead section)
- `template/docs/chapters/03-shared-context.md` — for collaboration model
- `template/docs/chapters/05-rules.md` — for team conventions
- `template/docs/chapters/06-skills.md` — for workflow overview

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the guide**

Warm, hand-holding tone. Walk through:

1. "You're setting up a workspace for your team." — motivation.
2. Scaffold the workspace and add your team's repos to workspace.json.
3. Set up shared-context/locked/ with team truths — project status, architectural decisions, coding standards. Explain what locked means and why it matters.
4. Choose which optional rules to activate (drop .skip) based on your team's needs.
5. Explain the collaboration model — how shared context flows between team members. User-scoped for personal work, root for team-visible, locked for always-loaded.
6. Walk through what a team member's first day looks like (preview the New Team Member guide).
7. Explain the release cycle briefly — how /complete-work and /release keep shared context clean.
8. Point to Chapters 3, 5, 6, 9.

~800-1200 words.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/guides/team-lead.md
git commit -m "docs: team lead guide"
```

---

### Task 15: New Team Member Guide

**Files:**
- Create: `template/docs/guides/new-team-member.md`

**Source material to read:**
- `design-go-public-docs.md` — guide spec (New Team Member section)
- `template/docs/chapters/01-what-is-a-workspace.md` — for orientation
- `template/docs/chapters/03-shared-context.md` — for finding team knowledge
- `template/docs/chapters/11-behavioral-patterns.md` — for practices

- [ ] **Step 1: Read all source material listed above**

- [ ] **Step 2: Write the guide**

Warm, hand-holding tone. Oriented around "here's what all this stuff is." Walk through:

1. "You've just joined a project that uses a claude-workspace. Here's how to get oriented." — motivation.
2. Clone the workspace repo. Run /setup — what it does, what to expect.
3. Tour the workspace — what each directory is for. repos/, shared-context/, .claude/. "Don't worry about memorizing this — it'll make sense as you use it."
4. Find your team's shared context — look in shared-context/locked/ for team truths. Read them. This is what Claude knows about your project.
5. Start your first work session — /start-work, pick a repo, name the session.
6. Do some work. Use /braindump if you make a decision worth capturing.
7. Complete or pause the session.
8. "You're set up. Here's where to go deeper." — point to Chapters 1, 3, 11.

~800-1200 words.

- [ ] **Step 3: Review against spec**

- [ ] **Step 4: Commit**

```bash
git add template/docs/guides/new-team-member.md
git commit -m "docs: new team member guide"
```

---

### Task 16: Final review and cross-reference check

- [ ] **Step 1: Verify all files exist**

```bash
ls template/docs/chapters/ template/docs/guides/
```

Expected: 11 chapter files + 3 guide files.

- [ ] **Step 2: Check cross-references**

Scan all docs for relative links and verify they point to files that exist:

```bash
grep -rn '\[.*\](.*\.md)' template/docs/
```

Fix any broken links.

- [ ] **Step 3: Verify word counts are in range**

```bash
for f in template/docs/chapters/*.md; do echo "$f: $(wc -w < $f) words"; done
for f in template/docs/guides/*.md; do echo "$f: $(wc -w < $f) words"; done
```

Chapters should be ~1500-2000 words. Guides should be ~800-1200 words. Flag any that are significantly outside range.

- [ ] **Step 4: Commit any fixes**

```bash
git add template/docs/
git commit -m "docs: fix cross-references and review pass"
```
