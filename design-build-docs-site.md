# Spec: `/build-docs-site` Skill

A skill that orchestrates the creation of a comprehensive, project-specific documentation site. Takes the user through framing, source gathering, scaffolding, writing, review, and diagrams — producing a Docusaurus site that consolidates scattered knowledge into a coherent branded reference.

## Purpose

Projects accumulate documentation across many places: a README in the repo root, a `docs/` folder with historical files, an old static site that's half-abandoned, comments in code, wiki pages, chat transcripts, design docs, braindumps. None of it tells a cohesive story. A new contributor has to stitch together understanding from fragments.

The `/build-docs-site` skill solves this by producing a single authoritative documentation site that **replaces** the scattered sources while treating them as raw material. Bad docs become exponentially better because the skill applies structure, narrative, diagrams, branding, and editorial discipline. Good docs become better because the skill fills gaps by reading the codebase and surfaces prior art the original author may have forgotten.

The output is a Docusaurus site — typically at `apps/docs-site/` in a monorepo, or `docs-site/` otherwise — with:
- Multi-part structure (Foundations / Systems / Integration or similar)
- Brand-consistent theming with light/dark mode
- Diagrams rendered as React/SVG components, theme-aware via CSS class cascade
- Navigable sidebar with clickable categories
- Migration mapping showing what old docs were replaced

## When to use

- A project has reached architectural maturity and documentation is scattered or stale
- The author wants a single source of truth that future contributors can onboard from
- Existing documentation is incomplete, outdated, or disorganized
- Output needs brand consistency and visual explanation through diagrams

## Not for

- Simple READMEs (use a README template)
- API reference docs (use the framework's doc generator)
- Blog content or marketing pages
- One-pagers, pitch decks, or external-facing product pages

## Prerequisites

- **Active work session required.** This is multi-hour work. Drive-by execution loses state on context compaction. The skill refuses to proceed without `/start-work`.
- **Project repo identified.** The target is the primary project repo in the workspace (or explicitly chosen if multiple).
- **Confirmed output location.** Default: `apps/docs-site/` for monorepos, `docs-site/` otherwise. User can override.

## Skill shape

Eight phases. The skill creates a task list at start and walks through them sequentially. Each phase has checkpoints where the user can redirect. The skill refuses to skip ahead.

```
Phase 0 — Prerequisites and project confirmation
Phase 1 — Framing (seven questions)
Phase 2 — Source gathering
Phase 3 — Spec writing with migration mapping
Phase 4 — Scaffold (Docusaurus install, brand, sidebar structure)
Phase 5 — Content writing (chapter by chapter, Chapter 1 last)
Phase 6 — Review sweeps (leak grep, forbidden-word grep, coverage, visual)
Phase 7 — Diagrams (inline, with optional session split checkpoint)
```

Migration is not a separate phase. The act of writing the new site IS the migration — old docs get synthesized into new chapters, and Phase 6's coverage check verifies nothing was dropped. After Phase 6 passes, the old files can be deleted without further ceremony. The skill reports which files are now replaced when content phase completes, so the user can delete them with confidence.

## Phase 0 — Prerequisites

Before starting:
- Verify `/start-work` has been called and a work session is active
- Confirm the target project repo (pull from session marker if only one, ask if multiple)
- Confirm the output location (`apps/docs-site/` default for monorepos)
- Check for an existing docs site at that location — if present, ask whether to replace or augment

If any prerequisite fails, the skill stops with a clear instruction to the user (e.g., "Run `/start-work` first, then invoke `/build-docs-site`").

## Phase 1 — Framing questions

Eight sequential questions walk through audience, existing docs, external sources, research treatment, language constraints, brand identity, reading pattern, and structure. Each answer is reflected back before the next question. All answers are captured in the spec and some become configuration (the language-constraint list, the chapter-split threshold) used by Phase 6.

### 1. Audience

"Who is this documentation primarily for? Pick one or describe your own."

- A. External stakeholders (investors, partners, collaborators)
- B. Future contributors (people joining the project)
- C. Community (product users, open-source consumers)
- D. Personal authoritative reference (study, revisit, present from)
- E. Other — describe

Multiple answers with weighting are acceptable. The skill records the primary audience and any secondary weights. This shapes tone and structural decisions downstream.

### 2. Existing documentation

"What existing documentation does your project have? I'll use it as a source and help you replace it with something better."

- Repo README and other root markdown files
- `docs/` directory in the repo
- An existing docs site (Docusaurus, MkDocs, GitBook, Starlight, other)
- Generated API docs
- Code comments / JSDoc / TSDoc
- Nothing — this is greenfield

For each selected option, the skill asks for specific paths. These become the source list for Phase 2 and the migration mapping in Phase 3.

### 3. External knowledge sources

"What other sources should I pull from?"

- Shared context files in the workspace
- Claude chat history from prior sessions on this project
- Notion export (if the user has one — the skill handles nested zips and emoji filenames)
- Confluence / wiki export
- Google Docs
- Other — describe

The skill confirms which sources the user wants to include and asks for paths or access methods.

### 4. Research treatment

Every mature project has work done "later" — research added after the initial design, or features designed but not built. The skill asks how to present these honestly.

Two sub-questions:

**Research timing.** "Was deeper research part of the original thought process, or added later?"
- Integrate throughout (research shaped the design from the start)
- Dedicated section only (research is valuable context but not foundational)
- Omit (research is tangential)

**Designed vs. built.** "Should the documentation reflect the full design or just what ships?"
- Unified design (implementation state is a separate concern tracked elsewhere)
- Flag what ships vs what's designed (explicit markers on unbuilt features)

This shapes Part III of the site structure and where aspirational content lives.

### 5. Language constraints

"Any words, phrases, or framings you want me to avoid?"

This is intentionally open-ended. Users often have specific things they don't want the documentation to claim or imply. Collect the list verbatim. The list gets saved to the spec and used by the forbidden-word grep in Phase 6.

If the user has none, move on. Don't push — this is a courtesy check.

### 6. Brand identity

"Should the site use your project's brand (fonts, colors, voice) or stay neutral?"

- Use project brand — ask for a pointer to the brand spec, identity doc, or existing site CSS
- Neutral — Docusaurus defaults with tasteful minimal overrides

If the user has a brand but no spec, the skill asks for: primary color, accent color, heading font, body font, mono font, any tone/voice guidelines. Records these in the spec.

### 7. Reading pattern and chapter sizing

"How will readers engage with this site? This determines how chapters are sized — long and comprehensive or short and atomic."

Three questions in sequence:

**Engagement style.**
- A. Linear — read top-to-bottom or major-section-by-major-section to build understanding
- B. Lookup — search or navigate to specific topics as needed
- C. Both — deep dive on first read, lookup on return visits

**Content cohesion preference.** "When a chapter covers multiple related concepts, should they stay together or split apart?"
- A. Together — context is more valuable than navigation. Longer pages are fine.
- B. Apart — each concept gets its own page, short and focused.
- C. Depends on length — split only when a chapter becomes unwieldy.

**Chapter length target.** Based on the above, the skill proposes a default split threshold:
- Linear + Together → 300+ lines before splitting
- Lookup + Apart → 80-120 lines
- Mixed → 150-200 lines

The skill proposes a number and asks the user to accept or adjust. This becomes the `chapterSplitThreshold` in the spec and governs Phase 6 feedback.

### 8. Structure

Based on the answers so far, the skill proposes two or three structural options:

- **Three-part**: Foundations → Systems → Integration. DDIA-style, deeply structured. Works for technical products with layered architecture.
- **Narrative spine**: Follow a user/learner journey through the product. Works for user-facing products or tutorials.
- **Hybrid**: Narrative within a structured frame. Works when the product has both architectural depth and a user journey story.

The skill recommends one based on audience and asks the user to pick or describe an alternative. User answers override recommendations — this is not a default-you-accept scenario.

## Phase 2 — Source gathering

The skill pulls material from all the places identified in Phase 1. Opinionated about completeness — scattered sources are the whole reason the site needs to exist.

### Standard sources

- **Codebase.** Read actual implementations using Glob and Grep. Find architectural patterns, public APIs, data models, configuration schemas. Don't just read existing docs about the code — read the code itself.
- **Shared context.** Handoffs, braindumps, locked team knowledge, release notes, prior spec documents.
- **Workspace inflight trackers.** Historical session records capture decisions that may not be anywhere else.
- **Existing project documentation** (from Phase 1). Read every file the user pointed at. Catalog topics covered and gaps.

### Chat history extraction

If the user has Claude chat dumps or is willing to point at the Claude projects directory, scan recent sessions for design discussions. These often contain reasoning that never made it into committed docs.

### Notion export handling

If a Notion export is provided:
- Notion exports are nested zips — the outer zip contains an inner zip with the actual content. Unzip twice.
- Inner zip filenames often contain emoji characters that break the standard `unzip` command. Use Python's `zipfile` module instead:
  ```python
  import zipfile
  with zipfile.ZipFile('inner.zip') as z:
      z.extractall('output/')
  ```
- Move extracted files to `.claude-scratchpad/` for working access, not shared context (they're not source of truth — they're raw material).

### Token economics

When choosing between live MCP calls and exports, prefer exports. Live calls for documentation consolidation waste tokens without gaining freshness — the author wants completeness, not real-time accuracy.

Skip content the user has explicitly excluded. Don't re-evaluate.

### Output of Phase 2

A `sources.md` file in the worktree root listing every source file, its topic, quality rating (sparse / adequate / comprehensive / outdated), and whether it's being replaced or just referenced. This feeds into the migration mapping in Phase 3.

## Phase 3 — Spec writing

The skill writes `design-docs-site.md` in the project worktree root. The spec is comprehensive enough to drive execution without a separate plan in most cases.

### Spec sections

1. **Purpose and audience.** From Phase 1 answers. One paragraph.
2. **Structure.** Parts, chapters, appendices. Each chapter has a one-paragraph synopsis.
3. **Existing documentation mapping.** Table showing old file → new chapter. This is the migration plan.
4. **Source inventory.** From `sources.md`. Categorized.
5. **Brand and style.** Colors, fonts, voice. From Phase 1 answer 6.
6. **Language constraints.** From Phase 1 answer 5. Gets used by the forbidden-word grep later.
7. **Research treatment.** Where research lives in the structure.
8. **Diagrams plan.** Which chapters have diagrams; what each diagram shows. Starts as stubs; flesh out before Phase 7.

### Implementation-detail rule

The spec enforces a strict rule: the documentation describes *concepts and roles*, not *library choices*. A library, framework, or model name only appears if the choice itself is architecturally meaningful.

The principle is general: readers should understand what a thing does and why it exists before they know what library provides it. Naming the library first collapses the concept into the implementation — the reader learns the brand but not the idea.

Two examples of the pattern:

- Instead of "uses a specific validation library for schema enforcement," describe the concept: "validates responses against a typed schema." The library is an implementation detail.
- Instead of "backed by a specific database with a specific feature," describe the capability: "backed by a relational database with row-level security." The choice of database is a Tech Stack question.

Detection is mechanical in Phase 6: the leak grep script reads the project's dependency manifests (`package.json`, `pyproject.toml`, etc.) and greps the documentation for any installed package or framework name. This produces project-accurate detection without a hardcoded master list — a project's docs can't accidentally leak a library it uses, but won't trigger on a library it doesn't.

The audience answer from Phase 1 shapes strictness. An external audience should be strict; a personal authoritative reference may benefit from selectively naming choices the author cares about.

Exception: the Tech Stack appendix, where implementation choices are the subject. The leak grep skips this file path.

### Brainstorm-acronym rule

Projects often have brainstorm-era acronyms that were load-bearing during design but don't translate to a documentation site. The skill asks: "Any terms from brainstorming that should be translated to descriptive names?"

For each acronym, the skill proposes a descriptive name and offers to keep the acronym as a parenthetical label after the concept is established. The descriptive name leads; the acronym survives only as a shorthand.

### Spec review

The skill walks the user through the spec. If the user approves, the plan phase is skipped by default — comprehensive specs for documentation sites are implementation plans already. The user can request a separate plan if sections need breakdown.

## Phase 4 — Scaffold

Before writing any content, the skill gets the infrastructure clean.

### Docusaurus install

```bash
npx create-docusaurus@latest {output-path} classic --typescript
```

Use the classic preset with TypeScript. Node 20+ required.

### Boilerplate cleanup

After install, remove:
- `blog/` directory
- `src/pages/index.tsx` (default React landing)
- `docs/tutorial-basics/` and `docs/tutorial-extras/` (example content)
- Default tutorial sidebar entries

Disable the blog in `docusaurus.config.ts` by setting `blog: false` in the preset options.

### Docs at root

Set `routeBasePath: '/'` in the docs preset options. Add `slug: /` frontmatter to the root doc so it becomes the homepage. Warning: do not have both a `slug: /` doc and a `src/pages/index.tsx` — they conflict at build time.

### Brand application

Write `src/css/custom.css` from the `custom.css.tmpl` template with user brand values from Phase 1:
- Primary color variable
- Accent color variable
- Font imports (Google Fonts or `@font-face`)
- `--ifm-*` overrides for Infima theme variables
- `[data-theme='dark']` dark mode variables
- Content column width, justified text, heading spacing rules (from captured Phase 6 feedback patterns)
- The `--dx-*` variables and `.dx-fill-*` / `.dx-stroke-*` rule layer (for diagrams)

### Sidebar placeholders

Build the full sidebar in `sidebars.ts` with every chapter and appendix as a placeholder. Each placeholder is an empty doc stub. The sidebar reflects the structure from Phase 1 answer 7.

### Diagram primitives stub

Copy the diagram primitives library from `template/.claude/skills/build-docs-site/templates/primitives/` into `src/diagrams/primitives/`. The primitives are fixed starting points — they don't need per-project customization.

### MDXComponents global (optional)

If the project expects many diagrams, create `src/theme/MDXComponents.tsx` so diagrams can be referenced globally in chapters without per-file imports. Skip if the project has few diagrams.

### Build verification

Run `npm run build`. Fix any scaffolding errors before moving on. Run `npm start` and let the user visually verify the landing page. Commit the scaffold as a clean starting point.

## Phase 5 — Content writing

Chapter by chapter, main thread only.

### Execution model

- **No subagents for writing.** The main thread preserves coherence across chapters. Subagents produce thin work and lose consistency.
- **Inflight tracker updates every 2-3 chapters.** A one-paragraph summary of what was written, any decisions made, any constraints surfaced. This survives context compaction.
- **No pausing at every chapter boundary.** The skill pushes through unless the user explicitly stops it.

### Chapter order

Write in spec order with **one inversion: Chapter 1 is written last.** This is a captured principle — the opening benefits from being written with full authority over what the rest of the book says. The skill writes a placeholder Chapter 1 during scaffold and replaces it at the end of Phase 5.

### Long-chapter awareness

After each chapter is written, if it exceeds ~150 rendered lines, the skill flags it for potential splitting. Splitting is deferred to Phase 6 feedback — don't split preemptively.

### Re-check after writing

After each chapter, re-read the spec section for that chapter to confirm nothing was missed. Note any gaps and add to a "gaps surfaced during writing" list for review.

### Source integration

While writing, the skill draws from the sources gathered in Phase 2. Each chapter may consolidate content from multiple sources. The skill should cite sources internally (not in the final prose) so Phase 6 coverage checks can verify nothing was dropped.

## Phase 6 — Review sweeps

Four passes, each fully completed before the next.

### Pass 1 — Leak grep

Run `node .claude/skills/build-docs-site/scripts/leak-grep.mjs {project-root} {docs-path}`. The script does not use a hardcoded master list. Instead, it derives the leak list dynamically from the project itself:

1. **Scan dependency manifests.** Read `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `Gemfile`, `go.mod`, etc. Extract installed package names.
2. **Scan imported modules.** Grep the project's source files for import statements and collect module names.
3. **Add spec-supplied terms.** The spec may include project-specific concepts that shouldn't leak (internal code names, abandoned approaches).
4. **Grep content files.** For each file under the docs path (excluding the Tech Stack appendix, identified by file path filter), search for any term in the derived list.
5. **Report hits with context.** Each hit shows file, line number, matched term, and surrounding text.

This produces project-accurate leak detection. A React project's docs won't over-trigger on generic React terms — but a reference to `Zustand` in prose will be flagged because Zustand appears in `package.json`.

For each hit, the skill proposes a concept-level replacement and shows it to the user. The user approves, rewrites, or marks the hit as acceptable (for cases where the name genuinely belongs — e.g., a direct user-facing integration that deserves naming).

The audience answer from Phase 1 shapes what counts as a leak. A reference written for external contributors should be stricter about implementation details than one written as a personal authoritative reference — the latter may benefit from naming specific choices the author cares about.

### Pass 2 — Forbidden-word sweep

Run `node .claude/skills/build-docs-site/scripts/forbidden-word-grep.mjs {docs-path} {wordlist}` using the language constraints from Phase 1. For each hit, the skill shows context and lets the user decide — sometimes a hit is a different meaning of the word.

### Pass 3 — Coverage check

For each item in the existing documentation mapping (from the spec), verify it's covered in the new site. The skill reads each old doc, extracts its topics, and checks that the mapped new chapter covers them. Any gaps are surfaced to the user.

This is the pass that makes sure the new site is strictly better than the old one — not just rewritten but complete.

### Pass 4 — Visual check

Start the dev server. Open the landing page and 2-3 random chapters in a browser. The user verifies:
- Layout and spacing feel right
- Brand is applied correctly
- Sidebar structure matches the spec
- Navigation works
- Dark mode toggles correctly
- Nothing is visibly broken

If the user flags issues, address them in order before continuing.

### Phase 6.5 — Feedback iteration

After the skill declares the content phase done, typical feedback falls into four categories that the skill should be ready to handle:

**CSS polish.**
- Text alignment: justified vs left
- Heading top margins: H2 (3.5rem typical), H3 (2.5rem), H4 (2rem)
- Paragraph and list-item bottom margins
- Adjacent-heading collapse rules
- Content column width (widen if justified text creates awkward right edges)

**Terminology corrections.**
- If the user used "book" or "textbook" as a tone reference during framing, drop "book" framing from the UI — rename to "reference" or "documentation" throughout
- Check for unintended framings that crept in during writing

**Long-page splits.**
- Chapters over ~150 lines become Docusaurus categories with overview + sub-pages
- Use the category `link` property with `type: 'doc'` so the category label is clickable
- Update `sidebars.ts` to reflect the nested structure
- Verify breadcrumbs after splitting

**Run config.**
- Offer to add IntelliJ run configurations (`.idea/runConfigurations/`) for dev and build
- Note: post-worktree-merge paths may need adjustment after `/complete-work`

## Phase 7 — Diagrams

This may be a separate work session if the content phase was long. The skill asks the user at the end of Phase 6:

"Ready to do diagrams? This can add significant content and may benefit from a fresh work session. Options: (A) continue now, (B) `/complete-work` on content and start a fresh session for diagrams, (C) defer diagrams."

If the user picks B, the skill exits cleanly and hands off to `/complete-work`. When a new session starts, the user re-invokes `/build-docs-site --diagrams` (or just `/build-docs-site` — the skill detects the existing site and resumes at Phase 7).

### Approach decisions

Before implementing, the skill presents four approach decisions:

1. **Tooling mix.** Plain SVG with selective D3 / D3 for everything / HTML+CSS where possible. Recommend plain SVG with selective D3 — simpler primitives, easier theme control.
2. **Reusable primitives.** Use the primitives library (default) / hand-craft each. Recommend primitives.
3. **Interactivity.** Mostly static / selectively interactive. Recommend mostly static — interactive diagrams are rarely worth the complexity in a reference site.
4. **Production order.** Reading order (spec order) / impact order (most-valuable first). Recommend reading order for consistency; user can override.

### Primitives library

The primitives were copied into `src/diagrams/primitives/` during scaffold. Phase 7 uses them to build chapter diagrams.

- `Box.tsx` — labelled rectangles with title/subtitle/variant
- `Arrow.tsx` — straight and elbow arrows with arrowhead markers
- `SectionTitle.tsx` — caption headings inside SVGs
- `Region.tsx` — grouped labelled containers
- `DiagramContainer.tsx` — wrapper with consistent padding, caption, theme-aware background
- `tokens.ts` — color tokens and class-name maps (`cls.fill.primary === 'dx-fill-primary'`)

### Chapter-by-chapter production

Walk the chapter list. For each chapter:
1. Review content
2. Propose 1-N diagrams with brief descriptions
3. Implement each diagram as a React component in `src/diagrams/chapters/`
4. Convert the chapter `.md` to `.mdx` if not already (required for JSX imports)
5. Embed the diagrams in the chapter
6. Visually verify

### Reuse

Diagrams can and should be reused across chapters when the same concept appears in multiple places. Import the component from its original chapter file rather than duplicating.

### Pitfall: CSS variables in SVG fill

This is the hardest technical trap and is captured in `checklists/pitfalls.md`. Summary:

CSS variables used directly in `fill="var(--x)"` or inline `style={{fill: 'var(--x)'}}` do not paint reliably in Chromium even when `getComputedStyle` reports the correct color. The cause is a mix of presentation-attribute specificity and paint-pipeline quirks depending on how the SVG is loaded.

**The fix**: Use class selectors. Define classes in `custom.css`:
```css
.dx-fill-primary { fill: var(--dx-primary); }
.dx-stroke-primary { stroke: var(--dx-primary); }
```

Apply via `className` on SVG elements, not `fill` attributes:
```tsx
<rect className="dx-fill-primary dx-stroke-stroke" />
```

The primitives library already uses this pattern. Chapter components written by hand must follow it.

### Pitfall: Bulk migration regressions

If a chapter component was initially written with `fill={colors.X}` and needs migration to class-based fills, the `bulk-fill-migration.py` script handles the common case but has known regressions:

1. **Duplicate `className=`.** Elements that already had a `className` attribute end up with two. JSX silently keeps the second (the original, now stale). The script's second pass merges duplicates, but verify.
2. **Missing `cls` import.** The script adds `cls.fill.X` references but doesn't update the import line. Build fails with undefined `cls`. The script's third pass handles imports, but verify.
3. **Variable-bound fills.** The script only matches the literal pattern `fill={colors.X}`. Variable-bound fills (`fill={labelColor}`, `fill={fillByVariant[variant]}`, ternary fills) need manual fixes. Expect ~5-10% of files to need hand-editing.

The script prints a list of files with variable-bound fills that need manual review.

### Pitfall: Playwright viewport screenshots

Viewport-cropped Playwright screenshots of diagram regions can come back blank even when the diagrams render correctly in the browser. Full-page screenshots work fine. DOM inspection via `browser_evaluate` is the authoritative source of truth for whether a diagram "works."

Never debug a diagram based on a viewport screenshot alone. If the screenshot is blank, check the DOM before assuming the diagram is broken.

### Arrowhead markers

SVG `<marker>` elements are awkward to drive from CSS classes because marker contents are in a shadow tree. It's acceptable to leave arrowhead fill as a hardcoded hex value if the theme difference is subtle. Flag as a known cosmetic issue, not a blocker.

## Completion

After Phase 7, the site is ready to replace the existing documentation. The skill produces a final report listing:
- Every old doc file that was used as a source and is now covered in the new site (safe to delete)
- Any old doc files that had content the skill couldn't place and deserve a user decision
- Any live URLs that may need redirects (the skill flags them but doesn't set them up)

The user decides what to delete. The skill does not delete automatically — deletion is a user action. This ends the skill's work; `/complete-work` handles the merge and release notes.

## Skill file structure

```
template/.claude/skills/build-docs-site/
├── SKILL.md                             # the orchestration
├── templates/
│   ├── docusaurus.config.ts.tmpl        # config with placeholders
│   ├── custom.css.tmpl                  # CSS with brand placeholders, rule-layer classes
│   ├── sidebars.ts.tmpl                 # sidebar scaffold
│   ├── spec.md.tmpl                     # design-docs-site.md template
│   └── primitives/                      # fixed copy-through files
│       ├── Box.tsx
│       ├── Arrow.tsx
│       ├── SectionTitle.tsx
│       ├── Region.tsx
│       ├── DiagramContainer.tsx
│       └── tokens.ts
├── scripts/
│   ├── leak-grep.mjs                    # scans project deps, greps docs for leaks
│   ├── forbidden-word-grep.mjs          # user-specific word avoidance
│   └── bulk-fill-migration.py           # colors.X → cls.fill.X with fixes
└── checklists/
    ├── framing.md                       # the eight questions
    ├── review.md                        # the four sweeps
    └── pitfalls.md                      # CSS vars, bulk scripts, Playwright, etc.
```

## Open design questions

1. **Existing docs site handling.** If the user points at an existing Docusaurus site, the skill could read its config and structure as a starting point rather than scaffolding from scratch. This is a non-trivial code path — worth considering but not required for v1.

2. **Chapter 1 inversion — always?** Captured from technical-writing research. Probably correct but the skill should let users override if they prefer writing in order.

3. **Brand spec format.** If the user has a brand spec, the skill reads it. If not, the skill prompts for specific values. Should there be a canonical format for brand specs the skill recognizes?

4. **Dependency manifest scanning scope.** The leak grep scans `package.json`, `pyproject.toml`, etc. Should it also scan nested workspaces (e.g., a monorepo with per-app `package.json` files) or just the project root? Recommendation: scan all found manifests; de-duplicate the combined list.

## Success criteria

The skill is successful if:
- A project with scattered or bad documentation can get a comprehensive branded site in a single work session (plus optional second session for diagrams)
- Every piece of existing documentation either gets replaced by something better or gets explicitly preserved with a reason
- The produced site passes its own review sweeps (leak grep clean, forbidden words addressed, coverage complete, visually clean)
- The user feels the new site is strictly better than what they had before
- A future contributor can onboard from the site alone
