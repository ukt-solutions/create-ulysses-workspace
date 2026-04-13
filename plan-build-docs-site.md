# Plan: `/build-docs-site` Skill Implementation

Implementation plan for the skill spec in `design-build-docs-site.md`. Tasks are ordered by dependency — earlier tasks unblock later ones. The plan keeps each task small enough to verify independently.

## Execution model

- Sequential, main thread only. No subagents for implementation (per superpowers rule on same-codebase parallel work).
- Each task includes acceptance criteria. Don't mark complete until criteria are met.
- Commit after each significant task so the work is resumable.
- Every created file goes through the generalization check before final commit (no project-specific references from the source session).

## Task order

### Group 1: Templates that don't depend on anything

**T1: Build diagram primitives library**
Files: `template/.claude/skills/build-docs-site/templates/primitives/{Box,Arrow,SectionTitle,Region,DiagramContainer}.tsx` + `tokens.ts`.

These are fixed copy-through files. They implement the class-based fill/stroke pattern that survives Chromium's SVG paint pipeline. `tokens.ts` exports both hex values and a `cls` map of class names.

Acceptance:
- Six TypeScript files, each self-contained
- All use `className={cls.fill.X}` / `className={cls.stroke.X}` — no direct `fill={...}` or inline style with CSS variables
- `DiagramContainer` wraps content with consistent padding, caption, theme-aware background class
- `tokens.ts` exports `colors` (hex), `cls` (class maps), and any shared layout constants
- No project-specific references (no brand names, no domain language)

**T2: Build custom.css template**
File: `template/.claude/skills/build-docs-site/templates/custom.css.tmpl`.

Placeholder-driven brand CSS. Contains:
- Infima variable overrides for primary/accent/background (placeholders: `{{BRAND_PRIMARY}}`, `{{BRAND_ACCENT}}`, etc.)
- Font imports (placeholder `{{BRAND_FONTS_IMPORT}}`)
- `--dx-*` variable definitions for light mode (placeholders for primary/surface/text/stroke)
- `[data-theme='dark']` section with dark variants
- `.dx-fill-*` and `.dx-stroke-*` rule-layer classes
- Typography rules: justified body text, heading spacing (H2 3.5rem, H3 2.5rem, H4 2rem top; paragraph 1.25rem bottom)
- Content column width at 760px
- Adjacent-heading collapse rules

Acceptance:
- Template file with `{{...}}` placeholders for brand values
- All captured CSS patterns present
- File builds (no syntax errors) when placeholders are replaced with real values

**T3: Build docusaurus.config.ts template**
File: `template/.claude/skills/build-docs-site/templates/docusaurus.config.ts.tmpl`.

Docusaurus config with:
- `routeBasePath: '/'` for docs-at-root
- `blog: false` in preset options
- Custom CSS registration
- Placeholder for site title, URL, favicon
- Dark mode enabled by default

Acceptance:
- Template file with placeholders for site-identifying values
- Config compiles when placeholders filled

**T4: Build sidebars.ts template**
File: `template/.claude/skills/build-docs-site/templates/sidebars.ts.tmpl`.

Sidebar config showing:
- Empty `docs` sidebar with placeholder categories
- Example of clickable category using `link: { type: 'doc', id: 'category-overview' }`
- Example of nested category

Acceptance:
- Valid TypeScript
- Compiles when imported by a real Docusaurus build
- Clear inline comments explaining how to extend

**T5: Build spec template**
File: `template/.claude/skills/build-docs-site/templates/spec.md.tmpl`.

Template for `design-docs-site.md` that the skill fills in during Phase 3. Has sections:
- Purpose and audience
- Structure (parts, chapters, appendices)
- Existing documentation mapping (table: old file → new chapter)
- Source inventory
- Brand and style
- Language constraints
- Research treatment
- Diagrams plan

Acceptance:
- Valid markdown with placeholders
- Frontmatter follows workspace shared-context conventions

### Group 2: Scripts

**T6: Build leak grep script**
File: `template/.claude/skills/build-docs-site/scripts/leak-grep.mjs`.

Node.js ES module. Takes two args: project root and docs path.

Behavior:
1. Scan project root for dependency manifests: `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `Gemfile`, `go.mod`. Include nested workspace manifests.
2. Extract package names from each.
3. Deduplicate into a combined list.
4. Walk docs path for `.md` and `.mdx` files, excluding files under `tech-stack/` or `appendix-tech-stack/` (configurable exclusion list).
5. For each file, grep for each package name. Report hits with line numbers and surrounding context.
6. Output JSON: `{ hits: [{file, line, term, context}], excluded: [...], manifestsScanned: [...] }`.

Acceptance:
- Runs via `node leak-grep.mjs {project} {docs}`
- Handles missing manifests gracefully (warn, continue)
- JSON output valid
- No external dependencies (uses Node stdlib only)

**T7: Build forbidden-word grep script**
File: `template/.claude/skills/build-docs-site/scripts/forbidden-word-grep.mjs`.

Node.js ES module. Takes: docs path and a word list (file path to a JSON array).

Behavior:
1. Read the word list.
2. Walk docs path for `.md` and `.mdx` files.
3. For each file, grep for each word (case-insensitive, word boundary).
4. Report hits with line numbers, matched word, surrounding context.
5. Output JSON: `{ hits: [{file, line, word, context}] }`.

Acceptance:
- Runs via `node forbidden-word-grep.mjs {docs} {wordlist.json}`
- Word boundary and case-insensitive options configurable via CLI flags
- JSON output valid

**T8: Build bulk fill migration script**
File: `template/.claude/skills/build-docs-site/scripts/bulk-fill-migration.py`.

Python script. Takes a directory of chapter component files.

Behavior:
1. For each `.tsx` file, replace `fill={colors.X}` with `className={cls.fill.X}`. Same for `stroke`.
2. Detect and merge duplicate `className=` attributes on the same element.
3. Detect `tokens` imports and add `cls` to the import list if missing.
4. Identify variable-bound fills (`fill={labelColor}`, `fill={fillByVariant[variant]}`, ternary) and leave them alone.
5. Report: files modified, files needing manual review (variable-bound patterns), regressions detected.

Acceptance:
- Python 3 standard library only (no dependencies)
- Handles the three known regression cases from the pitfalls checklist
- Reports manual-review files clearly
- Idempotent (running twice on already-migrated code produces no changes)

### Group 3: Checklists

**T9: Build framing checklist**
File: `template/.claude/skills/build-docs-site/checklists/framing.md`.

The eight framing questions in order, with:
- Question text
- Answer options
- What to record in the spec
- How the answer shapes downstream phases

Acceptance:
- All eight questions present
- Each question has explicit "records as" and "affects" lines

**T10: Build review checklist**
File: `template/.claude/skills/build-docs-site/checklists/review.md`.

The four review sweeps, each with:
- Command to run
- What to do with the output
- User decision points
- When the sweep is complete

Acceptance:
- All four sweeps documented
- Commands copy-paste ready

**T11: Build pitfalls checklist**
File: `template/.claude/skills/build-docs-site/checklists/pitfalls.md`.

Captured pitfalls with fixes. Sections:
- CSS variables in SVG fill (the class-selector fix)
- Bulk migration regressions (duplicate className, missing import, variable-bound fills)
- Playwright viewport screenshot quirk (use DOM inspection instead)
- Arrowhead markers (hardcoded hex acceptable)
- Notion export handling (nested zips, emoji filenames, use Python zipfile)

Each section has: symptom, cause, fix with code example, how to verify.

Acceptance:
- All five pitfalls documented
- Code examples in each section
- No project-specific references

### Group 4: The skill file itself

**T12: Build SKILL.md**
File: `template/.claude/skills/build-docs-site/SKILL.md`.

The main orchestration file. Follows the existing skill format: frontmatter, overview, parameters, prerequisites, phase-by-phase flow, notes.

Acceptance:
- Frontmatter: `name: build-docs-site`, `description:`
- All eight phases represented with actionable steps
- References templates, scripts, and checklists by relative path
- Creates a task list at start (matches the spec's phase list)
- Refuses to run without an active work session
- No project-specific references

### Group 5: Final passes

**T13: Generalization review**
Grep all created files for any source-project leaks. Known problem terms from the origin session: codeapy, forest teal, Fraunces, DM Sans, JetBrains Mono, learner, mentor, therapy, Pelanek, and any other domain language that might have crept in.

Acceptance:
- No hits on known terms
- Spot-check each file for tone and generality

**T14: Activate skill in workspace worktree**
Copy the new skill from `template/.claude/skills/build-docs-site/` to the workspace's `.claude/skills/build-docs-site/` so it's discoverable in this session for verification.

Acceptance:
- Skill appears in `/skills` listing
- Can be invoked (even if it just prints phase 0 and stops for lack of a test project)

**T15: Update inflight tracker**
Record final progress, any deferred items, notes for `/complete-work`.

Acceptance:
- Tracker reflects all completed tasks
- Any known gaps or TODOs are documented
- Ready for `/complete-work` to synthesize into release notes

## Dependencies

- T1 (primitives) has no dependencies — start here
- T2 (custom.css) depends on nothing structurally but the `.dx-*` class names must match what T1 uses in `tokens.ts`
- T3, T4, T5 are independent templates
- T6, T7, T8 are independent scripts
- T9, T10, T11 are independent checklists
- T12 (SKILL.md) depends on T1-T11 being at least structurally present so it can reference them by path
- T13 (generalization) depends on T1-T12
- T14 (activation) depends on T13
- T15 (tracker) is last

## Out of scope for this session

- Running the skill end-to-end on a real project (that's Phase 0 testing, not this session's deliverable)
- Publishing a new template release (happens in `/complete-work` / `/release`)
- Updating `/workspace-init` to install the new skill during init (the skill is part of the template payload; no separate integration needed)
- Adding to the `open-work.md` tracker (this session exists because of an explicit user request, not a tracked ticket)

## Risks

- **Skill directory convention.** This is the first skill in the template with a sub-directory structure. It works but breaks a convention. If it causes friction, follow-up work could either revert (inline everything into SKILL.md at the cost of size) or update other complex skills to follow the new pattern.
- **Script testing.** The scripts can't be fully exercised without a real Docusaurus project to run them against. Smoke-test with minimal fixture data where possible; full verification happens the first time someone uses the skill on a real project.
- **Docusaurus version drift.** The templates target Docusaurus 3.10+. If a user has an older version, scaffolding may fail. Document the version requirement in SKILL.md prerequisites.
