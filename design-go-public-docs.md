---
state: ephemeral
type: spec
topic: go-public-docs
branch: chore/go-public-docs
author: myron
updated: 2026-04-06
---

# Design: Go Public Documentation

## Problem

No user-facing documentation exists beyond CLAUDE.md and skill files. Someone who isn't the author cannot understand, install, or use a claude-workspace without hand-holding. This blocks public release.

## Solution

A two-tier documentation system: a textbook of 11 chapters covering every concept in the workspace, plus 3 audience-specific guides that onboard different user types.

## Documentation Structure

All docs live in `template/docs/` so they ship with the scaffold.

```
template/docs/
  guides/
    solo-developer.md
    team-lead.md
    new-team-member.md
  chapters/
    01-what-is-a-workspace.md
    02-work-sessions.md
    03-shared-context.md
    04-claude-md.md
    05-rules.md
    06-skills.md
    07-hooks-and-scripts.md
    08-agents.md
    09-the-release-cycle.md
    10-installation-and-upgrades.md
    11-behavioral-patterns.md
```

## Chapter Groupings

The chapters follow a narrative arc — the reader understands what and why first, then what the concrete pieces are, then how the system evolves, then how to use it well.

### Part I: Concepts

**Chapter 1: What Is a Workspace** — The core mental model. A workspace is a launcher root that stays on main. All work happens in worktrees. The three layers: template (upstream, generic) → team workspace (project-specific, committed) → personal (gitignored). Why conventions over configuration. Directory layout overview. How repos, shared context, and scratchpad relate.

**Chapter 2: Work Sessions** — The unit of tracked work. One branch, one or more worktrees, one lifecycle (/start-work → /complete-work). Session markers as source of truth. Worktree naming convention (`{session}___wt-{type}`). Multi-repo sessions — same branch across N repos + workspace. Parallel sessions in separate terminals. The chat session vs work session distinction.

**Chapter 3: Shared Context** — The memory system. Three levels: locked (team truths, always loaded, injected into subagents), root (team-visible ephemerals), user-scoped (personal working context). Inflight trackers per work session. Frontmatter conventions (state, lifecycle, type, topic, author, updated). How handoffs and braindumps feed shared context. The ephemeral → locked promotion lifecycle.

### Part II: The Toolkit

**Chapter 4: CLAUDE.md** — The entry point. How it's structured. The @-reference pattern for pulling in workspace.json and locked context. How Claude reads it — what lands in the system prompt, what gets loaded per-turn. How CLAUDE.md connects rules, skills, and shared context into a coherent configuration. How to customize it.

**Chapter 5: Rules** — Behavioral constraints Claude follows. Mandatory rules (coherent-revisions, git-conventions, honest-pushback, workspace-structure, memory-guidance) vs optional rules. The .skip activation pattern — `.md` = active, `.md.skip` = available but inactive. Loading order: CLAUDE.md → workspace.json → rules/ → locked context → skills on invocation. How to write custom rules. How rules and skills interact (rules set constraints, skills define workflows).

**Chapter 6: Skills** — Workflow commands invoked via `/skill-name`. Grouped by purpose:
- Capture: /braindump, /handoff, /aside
- Lifecycle: /start-work, /pause-work, /complete-work, /sync-work
- Admin: /promote, /release, /maintenance, /setup, /workspace-init, /workspace-update
Each skill gets: what it does, when to use it, what it produces, how it chains with others.

**Chapter 7: Hooks and Scripts** — The automation layer. Hooks fire on Claude Code events — what fires when, what each hook does, the additionalContext response model. The 8 hooks: session-start, session-end, pre-compact, post-compact, subagent-start, repo-write-detection, worktree-create, workspace-update-check. Scripts consolidate mechanical git sequences: create-work-session, cleanup-work-session, add-repo-to-session. How hooks and scripts work together.

**Chapter 8: Agents** — Subagent definitions in `.claude/agents/`. How skills dispatch agents (e.g., /aside dispatches aside-researcher). The subagent context injection model — SubagentStart hook injects locked context automatically. How to write custom agent definitions. Agent tool access and isolation.

### Part III: Lifecycle

**Chapter 9: The Release Cycle** — How release notes flow: branch work → `release-notes/unreleased/` → versioned release document → archive. How /complete-work synthesizes notes from specs, plans, trackers, and commits. How /release combines unreleased notes into a version. The ephemeral cleanup pattern — what happens to shared context after release. Version numbering conventions (fixes → patch, features → minor, breaking → major, assigned at release time).

**Chapter 10: Installation and Upgrades** — Scaffolding a new workspace with `--init`. Adding repos. The template version field in workspace.json. Upgrading with `--upgrade` — how the CLI stages a payload to `.workspace-update/`, how the /workspace-update skill applies it interactively. Running maintenance before and after upgrades. Staying current.

### Part IV: Practice

**Chapter 11: Behavioral Patterns** — "How to hold the tool." The practices that make the conventions work:
- One topic, one file
- Name before writing
- Rewrite, don't append (coherent revisions in practice)
- Braindump when you hear "we decided..."
- Keep locked context lean (<10KB)
- Clean up user-scoped ephemerals after release
- Don't skip capture on discussion sessions
- One chat session, one work session
- Let PreCompact nudge you

Each pattern gets: the rule, why it matters, what goes wrong if you skip it.

## Guide Documents

Three standalone guides with a warm, hand-holding tone. Written for someone who has never seen a claude-workspace. Heavy use of "you," step-by-step progression, concrete examples. Each guide ends by pointing the reader to specific textbook chapters.

### Solo Developer Guide (~800-1200 words)
**Audience:** Developer who uses Claude Code, wants workspace conventions for their own projects.
**Walks through:** Install → scaffold → clone a repo → start first work session → make changes → complete session. "You just did a full cycle."
**Points to:** Chapters 1, 2, 10.

### Team Lead Guide (~800-1200 words)
**Audience:** Developer setting up a workspace for a team.
**Walks through:** Scaffold → add multiple repos → set up locked context with team truths → explain conventions to the team. Covers the collaboration model — how shared context flows between people.
**Points to:** Chapters 3, 5, 6, 9.

### New Team Member Guide (~800-1200 words)
**Audience:** Developer joining an existing workspace.
**Walks through:** Clone the workspace → run /setup → understand what the files mean → start first work session → find team shared context. Oriented around "here's what all this stuff is."
**Points to:** Chapters 1, 3, 11.

## Writing Conventions

### Textbook chapters
- **Voice:** Authoritative, confident, direct. Spring's concept-first structure, Stripe's voice, Next.js clarity. Never hedges or over-explains.
- **Structure:** Opens with 2-3 sentence summary of what it covers and why. Concept explanation with inline examples. Closes with Key Takeaways (3-5 bullets).
- **Length:** ~1500-2000 words per chapter.
- **Examples:** Always inline, never on a separate page. Concrete, drawn from real workspace usage.
- **Cross-references:** Relative markdown links: `[work sessions](02-work-sessions.md)`.
- **Progressive disclosure:** Tell the reader what they need now, link to deeper content.

### Guide documents
- **Voice:** Warm, approachable, hand-holding. "You" oriented throughout. Would make sense to a junior developer.
- **Structure:** Step-by-step progression. Each step is an action with a visible result.
- **Length:** ~800-1200 words each.
- **Ending:** Always points to specific textbook chapters for deeper understanding.

## What This Does NOT Include

- README / landing page (#39) — separate task, different audience (evaluators)
- Product naming (#38) — blocker for public release but not a docs task
- Docusaurus setup — future task to wrap these markdown files as an HTML site
- Optional rules pack (#20) and product-integrity rule (#40) — not documentation
- Recipe documentation (#37) — ships when more recipes exist

## Source Material

- `shared-context/documentation-seeds.md` — core concepts, behavioral patterns, phrasings
- `shared-context/locked/project-status.md` — what's built, design decisions
- Existing skill files in `template/.claude/skills/` — authoritative workflow definitions
- Existing rule files in `template/.claude/rules/` — constraint definitions
- Existing hook files in `template/.claude/hooks/` — automation implementations
- Release notes in `release-notes/` — version history and change narratives
