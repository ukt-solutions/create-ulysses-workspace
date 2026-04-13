---
name: build-docs-site
description: Build a comprehensive Docusaurus documentation site for a project. Consolidates scattered knowledge sources (README, docs/, existing sites, code, shared context, chat dumps, exports) into a coherent branded reference with theme-aware diagrams. Replaces existing documentation while using it as raw material. Multi-hour skill — requires an active work session.
---

# Build Docs Site

Orchestrates the creation of a comprehensive, project-specific documentation site. Takes the user through framing, source gathering, scaffolding, writing, review, and diagrams — producing a Docusaurus site that consolidates scattered knowledge into a coherent branded reference.

The intent is to **replace** existing documentation while treating it as raw material. Bad docs become exponentially better because the skill applies structure, narrative, diagrams, branding, and editorial discipline. Good docs become better because the skill fills gaps from the codebase and surfaces prior art.

## Parameters

- `/build-docs-site` — start a new site or resume an in-progress one in the active work session
- `/build-docs-site --diagrams` — explicitly resume at Phase 7 (diagrams) on an existing site

## Prerequisites

This skill requires an active work session. It does multi-hour work and loses state on context compaction without one.

- Run `/start-work` first if no session is active
- Confirm the target project repo (the skill uses the session marker's `repos[0]` if there's only one)
- Default output location: `apps/docs-site/` for monorepos, `docs-site/` otherwise
- Docusaurus 3.10+ is the target — Node 20+ required on the user's machine

If any prerequisite fails, stop with a clear instruction. Do not proceed.

## Sub-resources

This skill bundles templates, scripts, and checklists in subdirectories:

```
build-docs-site/
├── SKILL.md (this file)
├── templates/
│   ├── docusaurus.config.ts.tmpl
│   ├── custom.css.tmpl
│   ├── sidebars.ts.tmpl
│   ├── spec.md.tmpl
│   └── primitives/
│       ├── Box.tsx
│       ├── Arrow.tsx
│       ├── SectionTitle.tsx
│       ├── Region.tsx
│       ├── DiagramContainer.tsx
│       └── tokens.ts
├── scripts/
│   ├── leak-grep.mjs
│   ├── forbidden-word-grep.mjs
│   └── bulk-fill-migration.py
└── checklists/
    ├── framing.md
    ├── review.md
    └── pitfalls.md
```

References below use paths relative to the skill directory.

## Flow

### Phase 0 — Prerequisites and project confirmation

1. Verify an active work session exists. If not: stop and instruct the user to run `/start-work`.
2. Read the session marker. Identify the target project repo. If multiple repos, ask which one.
3. Determine the output path. Default rules:
   - Monorepo (workspace files at root): `apps/docs-site/`
   - Single-package repo: `docs-site/`
4. Check for an existing site at the output path. If present, ask whether to:
   - Replace it entirely
   - Augment it (add chapters, keep existing ones)
   - Cancel
5. Create the task list for the rest of the phases (use TaskCreate for each phase). The user can see progress.

### Phase 1 — Framing

Walk through `checklists/framing.md`. Eight questions, sequential, reflect each answer back. Do not advance until all eight are answered.

The eight questions:
1. Audience
2. Existing documentation
3. External knowledge sources
4. Research treatment (timing + designed-vs-built)
5. Language constraints
6. Brand identity
7. Reading pattern and chapter sizing
8. Structure

After all answers, summarize and confirm before moving on.

### Phase 2 — Source gathering

Pull material from every source identified in Phase 1.

For the codebase:
- Use Glob and Grep to find architectural patterns, public APIs, data models, configuration schemas
- Read actual implementations, not just existing docs about them

For shared context:
- Walk `shared-context/` for handoffs, braindumps, locked team knowledge, release notes

For work-session history:
- Walk `work-sessions/*/session.md` for any currently-active session trackers — their bodies may contain decisions not yet consumed into release notes
- Check git history for previously-completed session trackers that were synthesized into release notes by `/complete-work`

For existing project documentation (from Phase 1 Q2):
- Read every file the user pointed at
- Catalog: topic covered, length, freshness, whether it's being replaced or just referenced

For Notion exports (from Phase 1 Q3):
- Notion exports are nested zips with emoji filenames. Use Python's `zipfile` module — see `checklists/pitfalls.md` section 5.

For chat history:
- If the user pointed at chat dumps or the Claude projects directory, scan recent sessions for design discussions

Output: write `sources.md` to the project worktree root. One section per source category. Each entry: file path, topic, quality (sparse / adequate / comprehensive / outdated), whether it's being replaced or referenced.

### Phase 3 — Spec writing

Read `templates/spec.md.tmpl`. Fill it in based on Phase 1 answers and the Phase 2 source inventory. Write the result to `design-docs-site.md` in the project worktree root.

The spec includes:
- Purpose and audience
- Reading pattern (engagement, cohesion, chapter split threshold)
- Structure (parts, chapters, appendices)
- Existing documentation mapping (table: old file → new chapter)
- Source inventory
- Brand and style
- Language constraints
- Research treatment
- Diagrams plan (stubs, fleshed out before Phase 7)
- Implementation-detail rule with project-specific terms
- Brainstorm-acronym translations

#### Implementation-detail rule

The documentation describes concepts and roles, not library choices. A library, framework, or model name appears only in the Tech Stack appendix unless the choice itself is architecturally meaningful.

Before writing the spec, ask: "Any project-specific terms I should add to the leak detection list?" These get added to the spec's `Project-specific leak terms` section.

#### Brainstorm-acronym rule

Ask: "Any terms from brainstorming that should be translated to descriptive names? Acronyms can survive only as parenthetical labels after the descriptive name is established."

For each acronym, propose a descriptive name and record both in the spec's `Brainstorm-acronym translations` section.

#### Spec review

Show the spec to the user. If approved, skip the plan phase by default — comprehensive docs-site specs ARE implementation plans. Generate a separate plan only if the user requests one for sections that need breakdown.

### Phase 4 — Scaffold

Get the infrastructure clean before writing any content.

#### Install Docusaurus

```bash
cd {project-root}
npx create-docusaurus@latest {output-path} classic --typescript
```

#### Cleanup defaults

Remove:
- `blog/` directory
- `src/pages/index.tsx`
- `docs/tutorial-basics/` and `docs/tutorial-extras/`
- Default tutorial sidebar entries

#### Configure for docs-at-root

Replace `docusaurus.config.ts` with the rendered `templates/docusaurus.config.ts.tmpl`, substituting placeholders from the spec's brand and project info.

Key settings:
- `routeBasePath: '/'` in the docs preset options
- `blog: false` in the preset options
- Root doc gets `slug: /` frontmatter

#### Apply brand

Replace `src/css/custom.css` with the rendered `templates/custom.css.tmpl`, substituting brand placeholders from the spec. The template includes:

- Infima theme overrides (light + dark)
- `--dx-*` diagram color variables
- `.dx-fill-*` and `.dx-stroke-*` rule-layer classes (REQUIRED for diagrams — see `checklists/pitfalls.md` section 1)
- Typography polish: justified text, heading spacing, content column width
- Diagram container styling

#### Build sidebar placeholders

Replace `sidebars.ts` with the rendered `templates/sidebars.ts.tmpl`, populated with the chapter list from the spec. Each chapter gets a placeholder doc stub.

#### Copy diagram primitives

Copy `templates/primitives/` (Box, Arrow, SectionTitle, Region, DiagramContainer, tokens) into `{output-path}/src/diagrams/primitives/`. These are fixed copy-through files.

#### MDXComponents global (optional)

If the project will have many diagrams, create `src/theme/MDXComponents.tsx` so chapter components can be referenced globally without per-file imports.

#### Build verification

```bash
cd {output-path}
npm run build  # must complete with no errors
npm start      # dev server
```

Have the user visually verify the landing page. Commit the scaffold as a clean starting point.

### Phase 5 — Content writing

Write chapters one at a time. Main thread only — no subagents.

#### Execution rules

- **No subagents for writing.** The main thread preserves coherence.
- **Inflight tracker updates every 2-3 chapters.** Write a one-paragraph summary of what was written, decisions made, constraints surfaced. Survives compaction.
- **No pausing at every chapter boundary.** Push through unless the user explicitly stops.

#### Chapter order

Write in spec order with **one inversion: Chapter 1 is written last.** Write a placeholder Chapter 1 first, then replace it at the end of Phase 5 with full authority over what the rest of the book actually says.

#### After each chapter

- Re-read the spec section for that chapter to confirm nothing was missed
- Note any gaps and add to a "gaps surfaced during writing" list for review
- If the chapter exceeds the spec's `chapterSplitThreshold`, flag it for potential splitting (deferred to Phase 6 feedback)

#### Source integration

While writing, draw from the Phase 2 sources. Each chapter may consolidate content from multiple sources. Track which sources fed which chapter so Phase 6 coverage check can verify nothing was dropped.

### Phase 6 — Review sweeps

Walk through `checklists/review.md`. Four passes:

1. **Leak grep** — `node .claude/skills/build-docs-site/scripts/leak-grep.mjs {project-root} {docs-path}`. For each hit, propose a replacement. User approves, rewrites, or marks acceptable.

2. **Forbidden-word sweep** — `node .claude/skills/build-docs-site/scripts/forbidden-word-grep.mjs {docs-path} {wordlist.json}`. For each hit, user decides.

3. **Coverage check** — verify every item in the existing-docs mapping is covered in the new site. Update mapping rows: `replaced`, `partial`, or `superseded`.

4. **Visual check** — `npm run build`, `npm start`, user inspects in browser.

Each pass fully complete before the next.

#### Phase 6.5 — Feedback iteration

After "done" is declared, expect feedback in four categories. Address each in order.

**CSS polish** — text alignment, heading spacing, paragraph spacing, content column width. Adjust `custom.css`.

**Terminology corrections** — drop any unintended "book" framing (replace with "reference" or "documentation"). Watch for tone-reference language that crept into UI strings.

**Long-page splits** — chapters over the spec's `chapterSplitThreshold` become Docusaurus categories with overview + sub-pages. Use the category `link` property with `type: 'doc'` so the category label is clickable. Update `sidebars.ts`. Verify breadcrumbs.

**Run config** — offer to add IntelliJ run configurations (`.idea/runConfigurations/`) for dev and build. Caveat: post-worktree-merge paths may need adjustment after `/complete-work`.

### Phase 7 — Diagrams

After Phase 6 is clean, ask:

> Ready to do diagrams? This can add significant content and may benefit from a fresh work session. Options:
> A. Continue now (recommended if context space is plentiful)
> B. `/complete-work` on content and start a fresh session for diagrams
> C. Defer diagrams entirely

If A: continue inline.
If B: exit cleanly and hand off. The user re-invokes `/build-docs-site --diagrams` in the new session.
If C: skip to Phase 8.

#### Approach decisions

Before implementing, ask:

1. **Tooling mix.** Plain SVG with selective D3 (recommended) / D3 for everything / HTML+CSS where possible
2. **Reusable primitives.** Use the bundled primitives (recommended) / hand-craft each
3. **Interactivity.** Mostly static (recommended) / selectively interactive
4. **Production order.** Reading order (default) / impact order

#### Chapter-by-chapter production

The primitives are already in `src/diagrams/primitives/` from Phase 4 scaffold. For each chapter:

1. Review the chapter content
2. Propose 1-N diagrams with brief descriptions
3. Implement each as a React component in `src/diagrams/chapters/{chapter-name}/`
4. Convert the chapter `.md` to `.mdx` if it's not already
5. Embed the diagrams in the chapter
6. Visually verify

Reuse aggressively — if the same concept appears in multiple chapters, import the existing component rather than duplicating.

#### Pitfalls

`checklists/pitfalls.md` has the full reference. The most important ones:

- **CSS variables in SVG fill don't paint reliably** — always use `className={cls.fill.X}`, never `fill={...}`. The primitives already do this.
- **Bulk migration regressions** — if you wrote chapter components with `fill={colors.X}` and need to migrate, run `python3 .claude/skills/build-docs-site/scripts/bulk-fill-migration.py {chapters-dir}`. The script handles duplicate `className=`, missing imports, and reports variable-bound fills for manual review.
- **Playwright viewport screenshots lie** — if a screenshot is blank, use DOM inspection via `browser_evaluate` before assuming the diagram is broken.
- **Arrowhead markers don't theme-switch** — acceptable cosmetic mismatch, or render two markers with media query switching.
- **SSR for browser-only diagrams** — wrap any diagram that uses browser APIs in `<BrowserOnly>` with a function child. The primitives don't need this; it only matters if a chapter component uses `window` or `document`.

### Phase 8 — Completion

The site is ready to replace the existing documentation.

Produce a final report:

- **Files now replaced and safe to delete.** Every old doc that was used as a source and is now fully covered in the new site.
- **Files needing user decision.** Any old docs with content that didn't migrate cleanly — coverage check found gaps the user needs to resolve.
- **URLs that may need redirects.** If the old docs had live URLs, list them. The skill flags but does not set up redirects.

Update the session tracker with the final state. The skill's work ends here. `/complete-work` handles the merge, release notes, and cleanup.

## Notes

- Specs and plans live at the project worktree root, not inflight (per workspace-structure rule). They are consumed by `/complete-work` into release notes.
- Diagrams primitives are deliberately fixed (no project customization) because the class-based fill pattern is load-bearing for theme support.
- The leak grep is project-accurate because it derives the list from the project's own dependency manifests. Do not maintain a hardcoded master list — it would over-trigger for projects whose docs legitimately discuss their own dependencies.
- The forbidden-word grep is per-project — each project supplies its own list from Phase 1 Q5. There is no default.
- This skill takes hours, not minutes. Always run inside an active work session. Update the session tracker periodically so context compaction doesn't lose state.
