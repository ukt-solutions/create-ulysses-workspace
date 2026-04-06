---
branch: chore/go-public-docs
type: chore
author: myron
date: 2026-04-06
---

## Go Public Documentation

Added a complete documentation system to the template: 11 textbook chapters and 3 audience-specific guides. Documentation ships with the scaffold at `template/docs/`.

### Chapters (textbook style — authoritative, concept-first)

Organized in four parts following a narrative arc:

**Part I: Concepts** — What Is a Workspace (directory layout, three layers, convention over configuration), Work Sessions (lifecycle, markers, worktrees, multi-repo, parallel sessions), Shared Context (three levels, capture skills, promotion lifecycle, ephemeral locked pattern).

**Part II: The Toolkit** — CLAUDE.md (structure, @-references, loading order, context cost), Rules (mandatory vs optional, .skip pattern, priority chain, custom rules), Skills (capture/lifecycle/admin groupings, all 13 skills documented), Hooks and Scripts (8 hooks, 3 scripts, the detect-decide-execute pattern), Agents (4 built-in agents, subagent context injection, custom agent definitions).

**Part III: Lifecycle** — The Release Cycle (pipeline stages, synthesis, ephemeral cleanup, version numbering), Installation and Upgrades (scaffolding, setup, template versioning, staged upgrades).

**Part IV: Practice** — Behavioral Patterns (9 practices: one topic one file, name before writing, rewrite don't append, braindump on decisions, keep locked lean, clean up ephemerals, capture discussions, one chat one session, let PreCompact nudge).

### Guides (warm, hand-holding tone)

**Solo Developer** — install through first complete session cycle. **Team Lead** — scaffold, configure repos, set up locked context, activate rules, onboard the team. **New Team Member** — clone, setup, orient, start first session.

### Writing voice

Chapters: Spring's concept-first structure, Stripe's confident voice, Next.js clarity. Guides: warm "you"-oriented walkthroughs accessible to junior developers. Both designed for NotebookLM audio generation.
