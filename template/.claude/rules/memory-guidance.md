# Memory Guidance

Guide Claude's auto-memory system for this workspace.

## What to Auto-Remember

When working in this workspace, pay attention to and save memories about:
- Architecture decisions and their rationale
- Patterns that caused bugs or confusion
- User corrections about project conventions
- External system URLs, credentials locations, API quirks
- Workarounds for tooling issues

## What NOT to Auto-Remember

- Temporary debugging state
- File contents (re-read them instead)
- Anything already captured in a workspace-context file
- Anything documented in .claude/rules/

## Session-Scoped vs Cross-Session

When a work session is active:
- Decisions and progress from this session → update the session tracker body at `work-sessions/{name}/workspace/session.md` (consumed by /complete-work)
- Patterns, corrections, and insights that apply beyond this session → auto-memory (persists across all sessions)
- Don't duplicate: if something is already in the session tracker, don't also save it to auto-memory

## Workspace-Context Frontmatter

Every workspace-context file should have YAML frontmatter. The fields below are conventions, not all required.

**Standard fields:**

- `state` — `locked` (team truth) or `ephemeral` (working context). Locked files live under `shared/locked/`; ephemeral files live elsewhere under `shared/` or `team-member/{user}/`.
- `lifecycle` — for ephemeral files: `active` (still relevant) or `resolved` (handled, kept for record).
- `type` — kind of content: `reference`, `braindump`, `handoff`, `research`, `design`, `index`, `canonical`, `promoted`.
- `priority` — for locked files only: `critical` (always loaded into canonical) or `reference` (eligible for trim/stub under canonical budget pressure). Default when absent is `critical`. See `build-workspace-context.mjs` for selection semantics.
- `topic` — kebab-case slug matching the filename (after the type prefix, when one is present).
- `author` — username scope owner. Required for `team-member/{user}/` files.
- `updated` — ISO date of last meaningful edit. `/maintenance` flags stale `lifecycle: active` files based on this.

**Index-feeding field:**

- `description` — one-line summary, used verbatim by `workspace-context/index.md` and per-user team-member indexes. When omitted, the index falls back to the first sentence of the body, then the filename slug (with the `braindump_`/`handoff_`/`research_` prefix stripped). Adding a `description:` to a file with a weak fallback is the cheapest way to improve the index.

**Optional confidence marker:**

- `confidence` — `high` | `medium` | `low`. Apply to research, design, and exploration files where the conclusions might still shift. Skip on locked files (locked = high by definition) and on workflow artifacts like handoffs and braindumps. The frontmatter integrity check in `/maintenance` validates the value if present.

**Example for a research file:**

```yaml
---
state: ephemeral
lifecycle: active
type: research
topic: vector-search-evaluation
description: Evaluation of FAISS for workspace-context — concluded NL index is sufficient at our scale.
author: alex
confidence: medium
updated: 2026-04-25
---
```

## Workspace-Context Auto-Generated Files

A single generator at `.claude/scripts/build-workspace-context.mjs` produces three artifacts in one pass:

- `workspace-context/index.md` — navigation catalog of everything under `shared/` (locked files first, then the rest). Imported by the workspace-level `CLAUDE.md`.
- `workspace-context/canonical.md` — verbatim concatenation of `shared/locked/*.md` so team truths are loaded into every session prompt. Also imported by `CLAUDE.md`.
- `workspace-context/team-member/{user}/index.md` — per-user navigation catalog, one per team member. Imported by each user's gitignored `CLAUDE.local.md`.

Gitignored files (e.g. anything matching `local-only-*`) are excluded automatically, and `workspace-context/.indexignore` adds path-prefix excludes for tracked files that shouldn't appear in the shared index (e.g. archived release notes).

When `workspace-context/canonical.md` exceeds `workspace.canonicalBudgetBytes` (default 40960), the builder honors per-file `priority` and section-level `<!-- canonical:trim --> ... <!-- canonical:end-trim -->` markers to fit: `priority: reference` files are trimmed first, then stubbed, while `priority: critical` files are always included in full. `/maintenance` audits the budget and offers a triage flow when over.

```bash
node .claude/scripts/build-workspace-context.mjs --check --root .   # exits 1 if any artifact is stale or missing
node .claude/scripts/build-workspace-context.mjs --write --root .   # regenerate all three
```

`/maintenance` checks staleness in audit mode and regenerates in cleanup mode. Hand edits to `index.md`, `canonical.md`, or any `team-member/{user}/index.md` are overwritten — update source files (or their `description:` frontmatter) instead.

## What Belongs in Canonical

Canonical content is loaded verbatim into every session prompt. It frames how Claude reads the rest of the conversation, so the bar for what goes in is narrower than the bar for `shared/` (root) or `team-member/{user}/`. The principle: canonical should describe what *is* and what *to do*, not what *to think*.

**Belongs in canonical (`shared/locked/`):**

- **Facts about the system** — current architecture, supported targets, naming conventions, where things live, what's published.
- **Hard constraints** — "must work on Windows and macOS," "PRs only, no direct push to main," "this directory is gitignored." Constraints scope the solution space without prejudging which solution to pick.
- **Process rules** — workflow discipline that applies regardless of the task. Branch protection, release cadence, mandatory review gates.
- **Settled-rejection guardrails** — "we evaluated approach X, rejected because Y, do not propose this again." Saves Claude from spending tokens re-proposing already-evaluated options. The guardrail must include the *why*, so future-Claude can recognize when an edge case actually warrants revisiting the rejection.
- **Meta-principles for debiasing** — explicit reminders to widen evaluation, like the dogfood-bias risk doc. Anti-shading by design.

**Does NOT belong in canonical:**

- **Opinions on open technical questions** — "library X is better than Y for this kind of problem," "approach A is preferred over B." These shape Claude's reasoning starting point so it begins from the conclusion rather than reasoning toward it. If the team has a strong preference, write it as a constraint ("use X, not Y") with the reason — or keep it in `shared/` (root) where it is reference material but not always-loaded.
- **Conclusions Claude might be asked to question** — "we believe the architecture is correct," "feature Z is the right shape." If a topic is the subject of ongoing design work, locking a conclusion biases the discussion before it starts.
- **Personal preferences** — what one contributor finds elegant or annoying. Belongs in `team-member/{user}/`.
- **Status snapshots that age fast** — sprint-current priorities, "we're working on X this week." `project-status.md` is the bounded exception for high-level project status; finer-grained "what's in flight" lives in the tracker.

**The test before promoting to canonical:**

> If Claude read this for the first time during a session about an unrelated topic, would it (a) help frame the problem correctly, or (b) push Claude toward a particular answer to a question that hasn't been asked yet?

(a) is canonical. (b) is `shared/` (root) at most, more often `team-member/{user}/`.

The distinction matters because pre-loaded conclusions in always-loaded context don't read like opinions to Claude — they read like ground truth. A reference doc Claude *finds* during research is weighed against the question; a canonical doc loaded before the question is asked frames what Claude considers in the first place. `/release` and `/promote` should apply this test before locking content.
