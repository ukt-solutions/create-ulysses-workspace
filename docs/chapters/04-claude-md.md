# CLAUDE.md

CLAUDE.md is the entry point of a workspace. It is the first file Claude reads on every conversation turn, and it determines what Claude knows about the project, what rules it follows, and what skills are available. If the workspace is a workbench, CLAUDE.md is the label on the front that says what this bench is for and where everything is.

This chapter explains how CLAUDE.md is structured, how it pulls in other configuration, and how to customize it.

---

## What Claude Sees

When Claude Code starts a conversation in a workspace directory, it reads CLAUDE.md from the current working directory. The content of this file lands in the system prompt area — the highest-priority position in Claude's context window. This means CLAUDE.md content is read first, remembered longest during compaction, and has the strongest influence on Claude's behavior.

The active rules in `.claude/rules/` are loaded alongside CLAUDE.md. So are the files CLAUDE.md imports with `@`: the canonical truths, and the index of team-visible context. `CLAUDE.local.md`, when present, adds your personal index. Together, these form the "always-loaded" context that Claude has on every turn — before any conversation happens, before any skill is invoked.

A rule is part of that cost only if it has no `paths:` frontmatter. A rule that declares `paths:` loads when a file matching one of its globs is read, and costs nothing until then. Skills work the same way at a finer grain: a skill's one-line description is always in context, so Claude knows the skill exists, but its body is read only when it is invoked. When you invoke `/start-work`, Claude reads the skill file at that moment. When the skill completes, its instructions are no longer actively loaded. This keeps the always-loaded footprint small.

## Structure

The default CLAUDE.md follows a consistent structure. This is the template as it ships:

```markdown
## Workspace: my-workspace

This is a claude-workspace. All conventions are defined in .claude/rules/.

## Quick Reference
- This root is the launcher — all work happens in workspace worktrees at `work-sessions/{name}/workspace/`
- `/start-work` to create or resume a work session
- Each session is a self-contained folder at `work-sessions/{name}/` containing the worktree, nested project worktrees, and the session tracker
- From root: only `local-only-*` and `workspace-scratchpad/` are writable
- Team knowledge lives in `workspace-context/`
- Run `/rename` to label this chat before `/clear` — keeps the chat findable in your CLI history after the context is wiped

## Workspace Config
Config lives in `workspace.json` — read it when a skill needs a value.
@local-only-template-freshness.md

## Team Knowledge
@CODEBASE.md
@workspace-context/canonical.md
@workspace-context/index.md

## Skills
- `/workspace-init` — first-time workspace setup (clone repos, install template, activate rules)
- `/start-work [handoff|blank]` — begin a work session
- `/handoff [name]` — save workstream state
- `/braindump [name]` — capture discussion/reasoning
- `/aside [--quick] <thought>` — capture a drive-by idea without interrupting current work
- `/pause-work` — suspend work, push, draft PR
- `/complete-work` — finalize the work — rebase, PR, merge, close the issue
- `/promote` — move personal memory to shared context
- `/release [version]` — cut a versioned release: bump, tag, forge release with generated notes
- `/sync-work` — push branches without ceremony
- `/workspace-update` — apply template updates, verified by a post-update audit
- `/setup-tracker` — wire this workspace to an issue tracker (GitHub Issues shipped; others pluggable)
- `/maintenance [audit|cleanup]` — scripted health audit and cleanup
- `/context-placement` — decide where durable content belongs and what each destination costs before writing it
- `/goal-driven-work` — run multi-phase autonomous work under `/goal` with phase artifacts and agent-team dispatch
- `/migrate-sessions` — drain session-model work sessions and switch the workspace to the task lifecycle
- `/build-docs-site` — build a comprehensive Docusaurus documentation site for a project

## Compact Instructions

When auto-compacting context, preserve in the summary:
- Decisions made in this session and their rationale
- Constraints and conventions established or confirmed
- Active task list state and the next concrete step
- File paths touched and the nature of the change
- Errors hit and what was tried

Drop from the summary:
- Verbose tool output already reflected in committed code
- Exploratory reads that did not lead to a change
- Conversational asides

Files in `workspace-context/`, the session tracker (`session.md`) or chat drawer (`workspace-scratchpad/chats/{chat}/`), and any `design-*.md`/`plan-*.md` survive compaction — they're on disk; re-read them on demand.
```

Each section has a purpose:

**Quick Reference** gives Claude (and you) the essential rules at a glance. These are the constraints that apply on every turn — where work happens, what is writable from the root, where team knowledge lives — and one habit worth keeping: `/rename` a chat before `/clear`, so it stays findable in your CLI history once its context is gone.

**Workspace Config** once imported `workspace.json` here; the import is gone. Most of that file exists for scripts (repo remotes, budgets, directory locations), and paying for all of it on every turn buys nothing. Instead, the SessionStart hook injects a one-line summary at the start of every chat — session model, tracker, forge, and the repo names — and skills read `workspace.json` itself when they need the details (the section keeps a plain pointer line, because ACP clients don't surface hook output). Beside the pointer, the section imports the machine-local template-freshness banner, `@local-only-template-freshness.md`, which the version-freshness-check hook keeps up to date.

**Team Knowledge** imports three files. `@workspace-context/canonical.md` carries the canonical truths verbatim: every file in `workspace-context/shared/locked/`, read on every turn. `@workspace-context/index.md` lists the team-visible working documents under `workspace-context/shared/`, one line each, so Claude knows they exist without paying for their content. `@CODEBASE.md` is an optional file-tree map that `/workspace-init` offers to generate, to help Claude navigate the code without exhaustive exploration. The two catalogs are generated from the files on disk — [Chapter 3](03-workspace-context.md) explains how.

**Skills** lists the available workflow commands — all seventeen the template ships, each with a one-line summary. This serves as both documentation for you and a reference for Claude to know what skills exist.

**Compact Instructions** tells Claude what to carry through an auto-compaction and what to drop. It ends by naming what survives compaction because it is on disk: files in `workspace-context/`, the session tracker or the task's chat drawer, and any `design-*.md` or `plan-*.md`.

## The @-Reference Pattern

The `@` prefix tells Claude Code to include the contents of a file or a directory. The template imports single files: `@workspace-context/canonical.md` and `@workspace-context/index.md` each pull one generated file into every turn.

This is how CLAUDE.md connects team knowledge into the context without duplicating content. Workspace config used to be pulled in the same way, via `@workspace.json` — but almost all of that file exists for scripts, so the import was replaced by a SessionStart hook line that summarizes it (session model, tracker, forge, repos) and by skills reading the file on demand.

You can add your own @-references. If your project has a critical architecture document that Claude should always see, add `@docs/architecture.md` to CLAUDE.md. If you have a local-only file with temporary context that you want front-of-mind, import it by name, as the template does with `@local-only-template-freshness.md`. It has to be by name: the generated catalogs skip gitignored files, so a `local-only-` note is never loaded just because of where it sits.

## Context Window Cost

The always-loaded context has a token cost. Every file pulled into CLAUDE.md is read on every turn, consuming context window space that could otherwise hold conversation history or tool results.

Measure it rather than estimating it. `.claude/scripts/context-footprint.mjs --root .` lists every contributor — CLAUDE.md, each import, each unconditional rule — and checks the total against the budget. On a fresh workspace built from the v0.26 template the total is about 25KB, which the script estimates at roughly 6,000 tokens: just over 3% of a 200k window, before any canonical file exists. Seven of the nine active rules are in that total. The other two declare `paths:` in their frontmatter and are counted only when a matching file is read.

Canonical context is one line item in that total, and the one a team controls. That is why `/workspace-init` targets under 10KB for it. At the script's estimate of four bytes to a token, 10KB is another 2,500 tokens on every turn, on top of what the template itself costs.

The whole always-loaded set has a ceiling in `workspace.json`: `workspace.alwaysLoadedBudgetBytes` (64KB from the template). `/maintenance` surfaces an over-budget total as a warning.

`workspace.json` also carries `workspace.canonicalBudgetBytes`, a ceiling on `canonical.md` alone. It is off by default — absent or `null` means every locked file ships in full. Setting a byte count opts in: when the canonical body exceeds it, the builder trims and then stubs `priority: reference` locked files (guided by their `<!-- canonical:trim -->` markers) to fit, and `/maintenance` reports the budget while it is set and offers triage when it is exceeded.

The practical implication: do not put large documents in canonical context. A 5,000-word design document does not belong in `workspace-context/shared/locked/` — it belongs in `shared/` or in your personal context, where it is read on demand. Locked is for concise, current team truths that Claude needs on every turn.

## Loading Order

When Claude processes a turn, configuration loads in a specific order. Understanding this order helps you know where to put things and what takes priority:

1. **CLAUDE.md** — the entry point. Quick reference, @-references, skill listing.
2. **SessionStart hook context** — the workspace summary line (session model, tracker, forge, repos), chat record, and open sessions, injected when the chat begins.
3. **Rules** — the active `.md` files in `.claude/rules/`. Behavioral constraints. A rule with `paths:` joins the set when a matching file is read.
4. **Canonical context** — through the `@workspace-context/canonical.md` import. Every file in `workspace-context/shared/locked/`.
5. **Skills** — loaded on invocation, not on every turn.

`workspace.json` itself sits outside this order: scripts read it directly, and skills read it on demand.

User instructions in CLAUDE.md take the highest priority. If CLAUDE.md says "never use semicolons" and a rule says "always use semicolons," CLAUDE.md wins. Rules override default Claude behavior but yield to explicit user instructions. Skills override rules where the skill explicitly says so (for example, the handoff skill auto-commits, which overrides the git-conventions rule's normal commit workflow).

## Customizing CLAUDE.md

CLAUDE.md is a template file that you own. The scaffold provides a default, but you can and should customize it for your project:

**Add project-specific quick reference.** If your project has conventions beyond the workspace defaults — a specific testing command, a deployment URL, a critical API endpoint — add them to the Quick Reference section.

**Add @-references.** If there are files Claude should always see — an architecture overview, a style guide, a domain glossary — add them as @-references. Be mindful of the token cost.

**Update the skills list.** If you add custom skills, document them here so Claude (and your team) knows they exist.

**Remove what does not apply.** If your team does not use a particular skill, removing it from the listing reduces noise. The skill itself stays in `.claude/skills/` and can still be invoked.

The one thing to preserve is the pair of `@workspace-context/` imports. They are how Claude stays aware of team knowledge — removing them disconnects Claude from the workspace's shared memory. The connection to `workspace.json` needs no import to preserve: the SessionStart hook summarizes it in every chat, and skills read the file when they need it.

Your edits survive upgrades. CLAUDE.md is a template file, so `/workspace-update` merges a new template into your customized copy — and asks about anything it cannot merge cleanly — instead of overwriting it.

---

## Key Takeaways

- CLAUDE.md is the entry point — Claude reads it on every turn in the highest-priority context position.
- The `@` imports pull in the canonical truths and the index of team-visible context without duplication; workspace.json is summarized by the SessionStart hook instead of imported, and skills read it on demand.
- Always-loaded context is a cost you can measure: `context-footprint.mjs --root .` prices it against `workspace.alwaysLoadedBudgetBytes`. A fresh v0.26 workspace is about 25KB, roughly 6,000 tokens.
- Loading order: CLAUDE.md → hook-injected workspace summary → rules → canonical context → skills on invocation.
- Customize CLAUDE.md for your project, but preserve the `@workspace-context/` imports that connect Claude to the workspace's shared memory.
