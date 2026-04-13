---
branch: feature/docs-site-skill
type: feature
author: myron
date: 2026-04-13
---

## `/build-docs-site` skill — comprehensive documentation site builder

A new skill that orchestrates building a Docusaurus documentation site for a project. Consolidates scattered knowledge sources (codebase, shared context, existing docs, chat dumps, exports) into a coherent branded reference with theme-aware diagrams. The intent is to **replace** existing documentation while treating it as raw material — bad docs become exponentially better, good docs become better.

### Eight phases

The skill walks through framing, source gathering, spec writing, scaffolding, content writing, review, diagrams, and completion. Each phase has explicit checkpoints and the skill refuses to skip ahead.

Framing asks eight sequential questions: audience, existing documentation, external knowledge sources, research treatment, language constraints, brand identity, reading pattern (with chapter-length sizing derived from engagement style and cohesion preference), and structure. Migration is not a separate phase — the act of writing the new site IS the migration. Phase 3's mapping table and Phase 6's coverage check verify nothing was dropped.

### Captured technique

The skill formalizes patterns that take hours to discover from scratch:

- **Theme-aware diagram primitives** that use class-based `fill`/`stroke` selectors. CSS variables in `fill="var(--x)"` or inline styles do not paint reliably in Chromium's SVG pipeline; class selectors with `fill: var(--x)` rules work consistently. The bundled primitives library (`Box`, `Arrow`, `SectionTitle`, `Region`, `DiagramContainer`, `tokens`) uses this pattern by default.
- **Implementation-detail leak detection** that derives its list from the project's actual dependency manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, etc.) instead of a hardcoded master list. A React project's docs won't over-trigger on generic React terms but will catch a stray `Zustand` reference because Zustand is in `package.json`.
- **Bulk fill migration** for converting hand-written diagram components from `fill={colors.X}` to `className={cls.fill.X}`, with handling for the three known regressions: duplicate `className=` attributes, missing `cls` import, and variable-bound fills that need manual review.
- **Content writing rules**: chapter-by-chapter on the main thread (no subagents), Chapter 1 written last, periodic inflight tracker updates, four review sweeps before declaring done.

### New files

The skill ships at `template/.claude/skills/build-docs-site/` with sub-directories for templates, scripts, and checklists:

- `SKILL.md` — eight-phase orchestration
- `templates/primitives/` — six React/SVG component files (Box, Arrow, SectionTitle, Region, DiagramContainer, tokens)
- `templates/custom.css.tmpl` — Infima overrides, `--dx-*` diagram variables, `.dx-fill-*`/`.dx-stroke-*` rule layer, typography polish (justified body, heading spacing, content column width)
- `templates/docusaurus.config.ts.tmpl` — `routeBasePath: '/'`, `blog: false`, brand placeholders
- `templates/sidebars.ts.tmpl` — clickable category link pattern
- `templates/spec.md.tmpl` — design-docs-site.md template the skill fills in during Phase 3
- `scripts/leak-grep.mjs` — dependency-derived leak detector (Node, no dependencies)
- `scripts/forbidden-word-grep.mjs` — user-supplied wordlist sweep (Node, no dependencies)
- `scripts/bulk-fill-migration.py` — fill→className migration with regression handling (Python 3 stdlib)
- `checklists/framing.md` — the eight framing questions with answer options and downstream effects
- `checklists/review.md` — the four review sweeps with commands and decision flows
- `checklists/pitfalls.md` — five captured pitfalls (CSS variables in SVG, bulk migration regressions, Playwright viewport screenshot quirks, arrowhead markers, Notion exports)

### New skill directory convention

This is the first skill in the template with a sub-directory structure (templates, scripts, checklists alongside SKILL.md). Existing skills are single-file. The convention break is justified because the skill orchestrates substantial bundled tooling that doesn't fit in a single file. Other complex skills could adopt the pattern later if it works well.
