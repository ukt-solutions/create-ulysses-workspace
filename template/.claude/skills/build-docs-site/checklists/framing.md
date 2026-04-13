# Framing Checklist

The eight framing questions for `/build-docs-site` Phase 1. Ask sequentially. Reflect each answer back before moving on. Capture all answers in the spec.

---

## 1. Audience

> Who is this documentation primarily for? Pick one or describe your own.
>
> A. External stakeholders (investors, partners, collaborators)
> B. Future contributors (people joining the project)
> C. Community (product users, open-source consumers)
> D. Personal authoritative reference (study, revisit, present from)
> E. Other — describe

**Multiple answers are acceptable** with weighting (e.g., "D primary, A secondary").

**Records as:** `audience.primary`, `audience.secondary` in the spec.

**Affects:**
- Tone (formal/conversational/technical)
- Implementation-detail strictness in Phase 6 (external is strict; personal allows selective naming)
- Structure recommendation in Q8

---

## 2. Existing documentation

> What existing documentation does your project have? I'll use it as a source and help you replace it with something better.
>
> - Repo README and other root markdown files
> - `docs/` directory in the repo
> - An existing docs site (Docusaurus, MkDocs, GitBook, Starlight, other)
> - Generated API docs
> - Code comments / JSDoc / TSDoc
> - Nothing — this is greenfield

For each selected option, **ask for specific paths**.

**Records as:** `existingDocs[]` in the spec, populating the migration mapping table.

**Affects:**
- Phase 2 source gathering (these become first-class sources)
- Phase 3 migration mapping
- Phase 6 coverage check
- Final completion report (which files are now safe to delete)

---

## 3. External knowledge sources

> What other sources should I pull from?
>
> - Shared context files in the workspace
> - Claude chat history from prior sessions on this project
> - Notion export (zip)
> - Confluence / wiki export
> - Google Docs
> - Other — describe

For each selected source, ask for paths or access methods.

**Notion gotcha:** Notion exports are nested zips with emoji filenames in the inner zip. Use Python's `zipfile` module, not the standard `unzip` command.

**Records as:** `externalSources[]` in the spec.

**Affects:** Phase 2 source gathering.

---

## 4. Research treatment

Two sub-questions.

### 4a. Research timing

> Was deeper research part of the original thought process, or added later?
>
> - Integrate throughout (research shaped the design from the start)
> - Dedicated section only (research is valuable context but not foundational)
> - Omit (research is tangential)

### 4b. Designed vs built

> Should the documentation reflect the full design or just what ships?
>
> - Unified design (implementation state is a separate concern)
> - Flag what ships vs what's designed (explicit markers on unbuilt features)

**Records as:** `researchTreatment.timing`, `researchTreatment.designedVsBuilt` in the spec.

**Affects:**
- Where research lives in the structure
- Whether unbuilt features get explicit "designed, not built" markers
- The narrative voice (factual vs aspirational)

---

## 5. Language constraints

> Any words, phrases, or framings you want me to avoid?

This is intentionally open-ended. Collect verbatim. If the user has none, move on — don't push.

**Records as:** `languageConstraints[]` in the spec, plus a separate `wordlist.json` file used by the forbidden-word grep in Phase 6.

**Format for wordlist.json:**
```json
[
  {"word": "term", "reason": "why to avoid it"}
]
```

**Affects:** Phase 6 review pass 2 (forbidden-word sweep).

---

## 6. Brand identity

> Should the site use your project's brand (fonts, colors, voice) or stay neutral?
>
> - Use project brand — point to the brand spec, identity doc, or existing site CSS
> - Neutral — Docusaurus defaults with tasteful minimal overrides

If the user has a brand but no spec, ask for:
- Primary color (hex)
- Accent color (hex)
- Background color (light mode)
- Background color (dark mode)
- Heading font
- Body font
- Monospace font
- Tone/voice guidelines (1-3 sentences)

**Records as:** `brand.*` in the spec.

**Affects:** Phase 4 scaffold (custom.css.tmpl substitution).

---

## 7. Reading pattern and chapter sizing

Three sub-questions in sequence.

### 7a. Engagement style

> How will readers engage with this site?
>
> A. Linear — read top-to-bottom or major-section-by-major-section
> B. Lookup — search or navigate to specific topics as needed
> C. Both — deep dive on first read, lookup on return visits

### 7b. Content cohesion preference

> When a chapter covers multiple related concepts, should they stay together or split apart?
>
> A. Together — context is more valuable than navigation. Longer pages are fine.
> B. Apart — each concept gets its own page, short and focused.
> C. Depends on length — split only when a chapter becomes unwieldy.

### 7c. Chapter length target

Based on the answers above, **propose a default split threshold**:

| Engagement | Cohesion | Recommended threshold |
|------------|----------|------------------------|
| Linear | Together | 300+ lines |
| Linear | Apart | 150 lines |
| Linear | Depends | 200 lines |
| Lookup | Together | 200 lines |
| Lookup | Apart | 80–120 lines |
| Lookup | Depends | 150 lines |
| Both | Together | 250 lines |
| Both | Apart | 120 lines |
| Both | Depends | 180 lines |

> Based on your answers, I'd suggest splitting chapters longer than {N} lines. Sound right, or adjust?

**Records as:** `readingPattern.engagement`, `readingPattern.cohesion`, `readingPattern.chapterSplitThreshold` in the spec.

**Affects:**
- Phase 6 long-chapter splits
- How chapters are written in Phase 5 (more concise vs more comprehensive)

---

## 8. Structure

Based on Q1 (audience) and Q7 (reading pattern), propose two or three structural options:

> Here are some structural options for your documentation:
>
> A. **Three-part** (Foundations → Systems → Integration). DDIA-style, deeply structured. Works for technical products with layered architecture.
> B. **Narrative spine** — follow a user journey through the product. Works for user-facing products or tutorials.
> C. **Hybrid** — narrative within a structured frame. Works when the product has both architectural depth and a journey story.
>
> Based on your answers, I'd suggest {recommendation}. Which fits your project, or describe your own?

**Records as:** `structure.type`, `structure.parts[]`, `structure.chapters[]` in the spec.

**Affects:** Everything downstream — sidebar, chapter list, source-to-chapter mapping.

---

## After all eight questions

Reflect the full set back as a summary:

> Here's what I have:
>
> - Audience: {primary} ({secondary if any})
> - Existing docs: {count} files / sites identified
> - External sources: {list}
> - Research treatment: {timing}, {designedVsBuilt}
> - Language constraints: {count} terms
> - Brand: {project / neutral}
> - Reading pattern: {engagement}, {cohesion}, {threshold} line threshold
> - Structure: {type}
>
> Ready to move to Phase 2 (source gathering)?
