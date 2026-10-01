---
name: context-placement
description: Use when deciding where a durable fact, instruction, or procedure belongs — a rule, canonical context, shared or personal context, auto-memory, or a skill — and when writing it once the destination is settled. Routes the decision, states the always-loaded cost before anything is written, and carries the frontmatter schema, generator invocations, and the canonical admission test.
---

# Context Placement

Something is worth keeping. This skill decides where it goes, and makes the cost of that
choice visible before you write it.

The hard part is routing, not prose. Most placement mistakes are not badly written files —
they are correctly written files in a destination that charges every future session for
them. Two of this workspace's own bugs (gh:136, gh:138) were exactly that: rules that had
quietly absorbed reference material and worked examples until the always-loaded directory
cost more than the conversation.

## The destinations

Exactly one of these. The right-hand column is what every session pays, forever, for the
choice.

| destination | route here when | always-loaded cost |
|---|---|---|
| **nowhere** | it is already covered somewhere, or it is true only today | zero |
| `.claude/rules/{name}.md` with `paths:` | an instruction that applies only when specific files are touched | zero until a matching file is read |
| `.claude/skills/{name}/SKILL.md` | a procedure with steps, invoked on demand | the `description` line, ~200 B |
| auto-memory | a machine-local preference or correction; not shared, not reviewable | one `MEMORY.md` line, ~100 B |
| `workspace-context/team-member/{user}/` | one person's working context | one index line, ~120 B, that user only |
| `workspace-context/shared/` | team-visible reference to look up when relevant | one index line, ~120 B |
| `workspace-context/shared/locked/` | a team-wide fact or constraint that passes the canonical test | **the whole file, every session** |
| `.claude/rules/{name}.md` (no `paths:`) | an instruction that must shape every session, everywhere in the repo | **the whole file, every session** |

The table is ordered by cost, cheapest first. Work down it and stop at the first
destination that genuinely fits. The two bold rows are the only ones that tax every
session; reach them only after the cheaper ones have actually been ruled out, not skipped.

**`nowhere` is the most common correct answer.** Before anything else, check whether the
thing is already stated. A second copy in a second location is worse than no copy: they
drift, and the reader cannot tell which one is current.

## Step 1 — classify what you have

Three kinds. The kind determines which destinations are even eligible.

- **Instruction** — changes what Claude *does*. "Never force push." "Rebase before opening
  a PR." Imperative, applies without being asked for. Eligible: rules (scoped or not).
- **Reference** — something Claude needs to *know* when a particular topic comes up. API
  shapes, schemas, architecture facts, why an approach was rejected. Eligible: canonical,
  shared, team-member, auto-memory.
- **Procedure** — a sequence of steps with a beginning and an end, run on request.
  Eligible: a skill.

Most drift comes from putting reference or procedure content in a rule. A rule that
contains an API table or a worked example is carrying reference material at instruction
prices. Split it: the instruction stays in the rule, the detail moves to a skill or a
context file, and the rule points at it in one line.

## Step 2 — scope it

For an instruction, the only question that matters is *when must this be true?*

- Every session, every file → unconditional rule.
- Only when certain files are involved → rule with `paths:`.

`paths:` is a real Claude Code feature and is almost always the better answer for anything
domain-specific. A rule about migration scripts, or about a single repo's test conventions,
does not need to be in context while you are editing documentation.

```yaml
---
paths:
  - ".claude/scripts/**/*.mjs"
  - "repos/*/template/.claude/scripts/**/*.mjs"
---
```

Rules with `paths:` load only when Claude reads a matching file. Rules without it load at
launch, at the same priority as `CLAUDE.md`, in every session — and, for anything shipped
in the template, in every downstream workspace too.

For reference content, scope is about reach. Pick the narrowest that works: auto-memory
(this machine only) → `team-member/{user}/` (one person) → `shared/` (the team) →
`shared/locked/` (the team, always loaded).

## Step 3 — state the cost, then write

Before writing, run the footprint tool and report the projection to the user in one line.
This step is not optional. Making the cost visible at the decision point is the whole
reason this skill exists.

```bash
node .claude/scripts/context-footprint.mjs --root .
node .claude/scripts/context-footprint.mjs --root . --add <bytes> --as <destination>
```

Valid `--as` values: `rule`, `rule-scoped`, `locked`, `shared`, `team-member`, `memory`,
`skill`, `nowhere`.

Say it plainly — "this adds 1.4 KB to every session, taking always-loaded context from
7.8% to 8.0% of the window" — and then write the file. If the projection looks
disproportionate to the value, go back to the table and take a cheaper row.

## The canonical test

Canonical content is loaded verbatim into every session prompt, so it frames how Claude
reads the rest of the conversation. The principle: canonical describes what *is* and what
*to do*, never what *to think*.

> If Claude read this for the first time during a session about an unrelated topic, would
> it (a) help frame the problem correctly, or (b) push Claude toward a particular answer to
> a question that hasn't been asked yet?

(a) is canonical. (b) is `shared/` at most, more often `team-member/{user}/`.

**Belongs in `shared/locked/`:**

- **Facts about the system** — architecture, supported targets, naming conventions, where
  things live, what is published.
- **Hard constraints** — "must work on Windows and macOS," "PRs only, no direct push to
  main." Constraints scope the solution space without prejudging the solution.
- **Process rules** — workflow discipline that applies regardless of task.
- **Settled-rejection guardrails** — "we evaluated X, rejected it because Y, do not propose
  it again." Must include the *why*, so a genuine edge case can still be recognised.
- **Meta-principles for debiasing** — explicit reminders to widen evaluation.

**Does not:**

- **Opinions on open technical questions.** "Library X beats Y here" makes Claude start
  from the conclusion instead of reasoning toward it. Write it as a constraint with its
  reason, or leave it in `shared/`.
- **Conclusions Claude might be asked to question.** Locking a conclusion on a topic still
  under design biases the discussion before it starts.
- **Personal preferences.** Those are `team-member/{user}/`.
- **Status snapshots that age fast.** `project-status.md` is the bounded exception; finer
  detail lives in the tracker.

Pre-loaded conclusions do not read as opinions to Claude — they read as ground truth. A
reference doc Claude *finds* while researching is weighed against the question; a canonical
doc loaded before the question is asked frames what Claude considers at all.

## Writing a workspace-context file

Frontmatter fields — conventions, not all required on every file:

- `state` — `locked` (team truth, lives under `shared/locked/`) or `ephemeral`.
- `lifecycle` — for ephemeral files: `active` or `resolved`.
- `type` — `reference`, `braindump`, `handoff`, `research`, `design`, `index`, `canonical`,
  `promoted`.
- `priority` — locked files only: `critical` (always in canonical) or `reference` (eligible
  for trim or stub under budget pressure). Absent defaults to `critical`.
- `topic` — kebab-case slug matching the filename after any type prefix.
- `author` — required for `team-member/{user}/` files.
- `updated` — ISO date of last meaningful edit. `/maintenance` flags stale `active` files.
- `description` — one line, used verbatim by the generated indexes. Without it the index
  falls back to the first sentence, then the filename slug. Adding one to a file with a
  weak fallback is the cheapest possible index improvement.
- `confidence` — `high` | `medium` | `low`. Use on research, design, and exploration where
  conclusions may still shift. Skip on locked files and on handoffs and braindumps.

```yaml
---
state: ephemeral
lifecycle: active
type: research
topic: vector-search-evaluation
description: Evaluation of FAISS for workspace-context — concluded the NL index is sufficient at our scale.
author: alex
confidence: medium
updated: 2026-04-25
---
```

## Regenerating the indexes

One generator produces all three artifacts in a single pass:

- `workspace-context/index.md` — catalog of `shared/` (locked first), imported by `CLAUDE.md`.
- `workspace-context/canonical.md` — verbatim concatenation of `shared/locked/*.md`, also
  imported by `CLAUDE.md`.
- `workspace-context/team-member/{user}/index.md` — per-user catalog, imported by each
  user's gitignored `CLAUDE.local.md`.

```bash
node .claude/scripts/build-workspace-context.mjs --check --root .   # exits 1 if stale
node .claude/scripts/build-workspace-context.mjs --write --root .   # regenerate
```

Gitignored files (anything matching `local-only-*`) are excluded automatically, and
`workspace-context/.indexignore` adds path-prefix excludes for tracked files that should
not appear in the shared index.

When `canonical.md` exceeds `workspace.canonicalBudgetBytes` (default 40960), the builder
honours per-file `priority` and section-level `<!-- canonical:trim --> ... <!-- canonical:end-trim -->`
markers to fit: `priority: reference` files are trimmed, then stubbed; `priority: critical`
files are always included in full. `/maintenance` audits the budget and offers triage when
over.

Hand edits to `index.md`, `canonical.md`, or any per-user index are overwritten. Change the
source file or its `description:` instead.
