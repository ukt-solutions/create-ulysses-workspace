# CLAUDE.md

CLAUDE.md is the entry point of a workspace. It is the first file Claude reads on every conversation turn, and it determines what Claude knows about the project, what rules it follows, and what skills are available. If the workspace is a workbench, CLAUDE.md is the label on the front that says what this bench is for and where everything is.

This chapter explains how CLAUDE.md is structured, how it pulls in other configuration, and how to customize it.

---

## What Claude Sees

When Claude Code starts a conversation in a workspace directory, it reads CLAUDE.md from the current working directory. The content of this file lands in the system prompt area — the highest-priority position in Claude's context window. This means CLAUDE.md content is read first, remembered longest during compaction, and has the strongest influence on Claude's behavior.

Rules from `.claude/rules/` are loaded alongside CLAUDE.md. Locked shared context files referenced via `@` are also pulled in. Together, these form the "always-loaded" context that Claude has on every turn — before any conversation happens, before any skill is invoked.

Skills, by contrast, are loaded on demand. When you invoke `/start-work`, Claude reads the skill file at that moment. When the skill completes, its instructions are no longer actively loaded. This keeps the always-loaded footprint small.

## Structure

The default CLAUDE.md follows a consistent structure:

```markdown
## Workspace: my-workspace

This is a claude-workspace. All conventions are defined in .claude/rules/.

## Quick Reference
- This root is the launcher — all work happens in workspace worktrees
- `/start-work` to create or resume a work session
- Worktrees: `work-sessions/{session}/workspace/` with nested project worktrees at `work-sessions/{session}/workspace/repos/{repo}/`
- From root: only `local-only-*` and `workspace-scratchpad/` are writable
- Shared memory lives in `shared-context/`

## Workspace Config
@workspace.json

## Team Knowledge (always loaded)
@shared-context/locked/

## Skills
- `/workspace-init` — first-time workspace setup
- `/start-work [handoff|blank]` — begin a work session
- `/handoff [name]` — save workstream state
- `/braindump [name]` — capture discussion/reasoning
- `/aside [--quick] <thought>` — capture a drive-by idea
- `/pause-work` — suspend work, push, draft PR
- `/complete-work` — finalize branch, release notes, real PR
- `/promote` — move personal memory to shared context
- `/release [version]` — combine unreleased notes into versioned doc
- `/sync-work` — push branches without ceremony
- `/workspace-update` — apply template updates
- `/maintenance [audit|cleanup]` — workspace health checks
```

Each section has a purpose:

**Quick Reference** gives Claude (and you) the essential rules at a glance. These are the constraints that apply on every turn — where work happens, what is writable from the root, where shared memory lives.

**Workspace Config** uses the `@workspace.json` reference to pull the workspace configuration into Claude's context. Claude sees the repo manifest, the template version, and the workspace settings without you needing to paste them.

**Team Knowledge** uses `@shared-context/locked/` to pull all locked context files into Claude's context. This is where team truths — project status, architectural decisions, risk warnings — get loaded automatically. Every file in this directory is read on every turn.

**Skills** lists the available workflow commands. This serves as both documentation for you and a reference for Claude to know what skills exist.

## The @-Reference Pattern

The `@` prefix tells Claude Code to include the contents of a file or directory. When CLAUDE.md contains `@workspace.json`, Claude reads workspace.json and includes its contents as part of the context. When it contains `@shared-context/locked/`, Claude reads every file in that directory.

This is how CLAUDE.md connects disparate pieces of configuration into a coherent picture without duplicating content. The workspace config lives in workspace.json (where scripts and the CLI read it), team knowledge lives in shared-context/locked/ (where release and promote manage it), and CLAUDE.md references both.

You can add your own @-references. If your project has a critical architecture document that Claude should always see, add `@docs/architecture.md` to CLAUDE.md. If you have a local-only file with temporary context, add `@shared-context/locked/local-only-my-notes.md`.

## Context Window Cost

The always-loaded context has a token cost. Every file pulled into CLAUDE.md is read on every turn, consuming context window space that could otherwise hold conversation history or tool results.

The default workspace template costs approximately 1,500 tokens always-loaded — CLAUDE.md itself, workspace.json, active rules, and settings. That is roughly 0.15% of the Opus context window. This leaves ample room for conversation, but the cost grows with each file added to locked context.

This is why locked context has a 10KB budget target. A 10KB locked directory adds approximately 2,500 tokens to the always-loaded cost, bringing the total to around 4,000 tokens — still well under 1% of the context window, but enough that discipline matters.

The practical implication: do not put large documents in locked context. A 5,000-word design document does not belong in `shared-context/locked/` — it belongs in user-scoped context where it is read on demand. Locked is for concise, current team truths that Claude needs on every turn.

## Loading Order

When Claude processes a turn, configuration loads in a specific order. Understanding this order helps you know where to put things and what takes priority:

1. **CLAUDE.md** — the entry point. Quick reference, @-references, skill listing.
2. **workspace.json** — via @-reference. Repo manifest, settings.
3. **Rules** — all `.md` files in `.claude/rules/`. Behavioral constraints.
4. **Locked context** — via @-reference. All files in `shared-context/locked/`.
5. **Skills** — loaded on invocation, not on every turn.

User instructions in CLAUDE.md take the highest priority. If CLAUDE.md says "never use semicolons" and a rule says "always use semicolons," CLAUDE.md wins. Rules override default Claude behavior but yield to explicit user instructions. Skills override rules where the skill explicitly says so (for example, the handoff skill auto-commits, which overrides the git-conventions rule's normal commit workflow).

## Customizing CLAUDE.md

CLAUDE.md is a template file that you own. The scaffold provides a default, but you can and should customize it for your project:

**Add project-specific quick reference.** If your project has conventions beyond the workspace defaults — a specific testing command, a deployment URL, a critical API endpoint — add them to the Quick Reference section.

**Add @-references.** If there are files Claude should always see — an architecture overview, a style guide, a domain glossary — add them as @-references. Be mindful of the token cost.

**Update the skills list.** If you add custom skills, document them here so Claude (and your team) knows they exist.

**Remove what does not apply.** If your team does not use a particular skill, removing it from the listing reduces noise. The skill still exists in `.claude/skills/` — it just will not be suggested.

The one thing to preserve: the `@workspace.json` and `@shared-context/locked/` references. These are how Claude stays aware of the workspace configuration and team knowledge. Removing them disconnects Claude from the workspace model.

---

## Key Takeaways

- CLAUDE.md is the entry point — Claude reads it on every turn in the highest-priority context position.
- The `@` pattern pulls in workspace.json and locked context without duplication.
- Always-loaded context costs ~1,500 tokens by default. Keep locked context under 10KB to stay lean.
- Loading order: CLAUDE.md → workspace.json → rules → locked context → skills on invocation.
- Customize CLAUDE.md for your project, but preserve the @-references that connect Claude to the workspace.
