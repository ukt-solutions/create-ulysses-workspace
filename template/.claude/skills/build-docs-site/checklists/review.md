# Review Checklist

The four review sweeps for `/build-docs-site` Phase 6. Run each pass fully before moving to the next. Each pass surfaces issues; the user decides on each one before completion.

---

## Pass 1 — Leak grep (implementation-detail detection)

**What it does:** Scans the project's dependency manifests to derive a list of installed packages, then greps documentation content for any mention of those names. Project-accurate detection, no hardcoded master list.

**Run:**
```bash
node .claude/skills/build-docs-site/scripts/leak-grep.mjs {project-root} {docs-path}
```

Optional flags:
- `--exclude path1,path2` — additional file paths to skip beyond the default Tech Stack exclusions

**Default exclusions:** Files under paths matching `tech-stack`, `appendix-tech-stack`, `appendix/tech-stack`, `technology`, `stack` are skipped because implementation choices are the subject in those locations.

**For each hit:**

1. Show the user: file, line, matched term, context
2. Propose a concept-level replacement
3. User decides:
   - **Replace** — apply the proposed rewrite
   - **Rewrite** — user provides their own rewrite
   - **Acceptable** — leave as-is (some terms are intentionally named, e.g., a primary integration that deserves naming)

**Pass complete when:** every hit has been addressed (replaced, rewritten, or marked acceptable).

**Audience consideration:** Strict for external audiences (B, C in framing Q1). More permissive for personal authoritative reference (D) where the author may want to name specific choices they care about.

---

## Pass 2 — Forbidden-word sweep

**What it does:** Greps documentation for user-supplied words to avoid (the language-constraints answer from Phase 1).

**Run:**
```bash
node .claude/skills/build-docs-site/scripts/forbidden-word-grep.mjs {docs-path} {wordlist.json} [--word-boundary] [--case-sensitive]
```

The `wordlist.json` was created during Phase 1 from the user's answers. Default options are case-insensitive, no word-boundary requirement.

**For each hit:**

1. Show the user: file, line, matched word, reason (if provided), context
2. User decides:
   - **Replace** — propose alternate phrasing, user approves or rewrites
   - **Acceptable** — sometimes a hit is a different meaning of the word (e.g., "leverage" as a noun in physics context vs. corporate filler)

**Pass complete when:** every hit has been addressed.

---

## Pass 3 — Coverage check

**What it does:** Verifies every item in the existing documentation mapping (from the spec) is covered in the new site. This is the pass that ensures the new site is strictly better than the old one — not just rewritten but complete.

**No script — this is a manual pass with structure.**

**For each row in the spec's "Existing documentation mapping" table:**

1. Read the old file
2. Extract the topics it covers (use Claude's reading, not regex)
3. Open the mapped new chapter(s)
4. Verify each topic is covered

**For any topic not covered:**
- Add it to the new chapter, OR
- Mark the old file as "partial replacement" and note what wasn't migrated, OR
- Decide the topic is genuinely obsolete and remove it from the mapping

**Update the mapping:**
- `replaced` — new site fully covers it; old file is safe to delete
- `partial` — some content didn't migrate; decisions noted in spec
- `superseded` — old content is obsolete; intentionally not carried forward

**Pass complete when:** every mapping row has a final status.

---

## Pass 4 — Visual check

**What it does:** Confirms the site builds cleanly and renders correctly in a real browser.

**Run:**
```bash
cd {docs-path}
npm run build  # must complete with no errors
npm start      # dev server
```

**Open in browser** (the user does this):
- Landing page
- 2-3 random chapters from different parts
- A chapter known to have diagrams (if Phase 7 has been done)

**Verify:**
- Layout and spacing feel right (justified text, heading spacing, no awkward gaps)
- Brand is applied correctly (colors, fonts, logo)
- Sidebar structure matches the spec
- Navigation works (sidebar links, breadcrumbs, in-page links)
- Dark mode toggles correctly
- Diagrams render (if applicable) — both light and dark modes
- Nothing visibly broken

**For any issues:**
- CSS polish issues (spacing, alignment, column width) → adjust `custom.css`
- Broken links → fix the `sidebars.ts` reference or doc id
- Layout problems → typically a typography setting in `custom.css`
- Diagram issues in dark mode → check `pitfalls.md` for the CSS-class-cascade pattern

**Pass complete when:** the user confirms the site looks ready.

---

## After all four passes

Update the session tracker with:
- Pass 1 hits resolved (count, summary of categories)
- Pass 2 hits resolved (count)
- Pass 3 mapping final state (replaced/partial/superseded counts)
- Pass 4 visual check confirmed

If Phase 7 (diagrams) hasn't been done yet, ask the user about doing it now or in a separate session (see SKILL.md Phase 7 checkpoint).

If Phase 7 is done, the skill is ready for `/complete-work`.
