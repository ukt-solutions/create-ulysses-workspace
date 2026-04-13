# Shared Context

Shared context is the workspace's memory system. It is where team knowledge lives, where work-in-progress reasoning accumulates, and where decisions are recorded for future sessions. Everything in shared context is a markdown file tracked in git — which means it is versioned, shareable, and survives workstation switches.

This chapter explains the three levels of shared context, how content gets created, and how it flows through the promotion lifecycle.

---

## Everything Is a File

The workspace has no database, no API, no external service for context storage. Shared context is a directory of markdown files. Claude reads them. Hooks inject them. Skills create and consume them. Git tracks them.

This design is deliberate. Files are portable, diffable, and readable by humans and AI alike. A new team member can browse `shared-context/` and understand the project's accumulated knowledge without any special tooling. A subagent can be injected with team context by reading files from a directory. The simplicity of "it's just files" is load-bearing.

Each file has YAML frontmatter that declares its metadata:

```yaml
---
state: ephemeral
lifecycle: active
type: braindump
topic: auth-redesign
author: myron
updated: 2026-04-05
---
```

The frontmatter fields serve different consumers. `state` tells the system whether this file is ephemeral (temporary, evolving) or locked (team truth, always loaded). `lifecycle` tracks whether the content is active, resolved, or superseded. `type` categorizes the content — braindump, handoff, tracker, reference. `topic` names what the file is about. `author` and `updated` track provenance.

## Three Levels

Shared context has three levels of visibility, each with different scope and lifecycle rules:

### Locked — Team Truths

`shared-context/locked/` contains knowledge that the entire team needs on every session. These files are loaded into Claude's context automatically — they appear alongside CLAUDE.md in the system prompt area. They are also injected into every subagent via the SubagentStart hook.

Locked context is the highest-attention position in the workspace. Content placed here gets maximum visibility: Claude reads it first, it survives context compaction longest, and subagents receive it even though they have no conversation history.

Because of this prominence, locked context has a budget. The target is under 10KB total (~2,500 tokens, about 0.25% of the context window). Every file in locked costs tokens on every turn. The `/release` skill's synthesis cycle is the natural pressure valve — it consolidates ephemeral knowledge into concise locked entries and removes what is no longer current.

Examples of locked content: project status summaries, architectural decisions that affect daily work, active risk warnings, team coding standards.

### Root — Team-Visible Ephemerals

`shared-context/` (root level, outside of locked/ and user directories) contains files that are visible to the whole team but not loaded automatically. These are working documents: milestone trackers, research findings, design explorations, product inventories.

Root-level files are an explicit choice. Content lands here when you deliberately want the team to see it — a cross-team handoff, a research summary that multiple people will reference, a planning document. The default destination for captures is user-scoped, not root.

### User-Scoped — Personal Working Context

`shared-context/{user}/` contains one person's working context. This is the default destination for everything captured outside of an active work session. Standalone braindumps, ongoing reference material, personal notes.

Session-scoped state (the session tracker, specs, plans) does NOT live in shared-context. It lives in `work-sessions/{name}/` — each session is self-contained. Inside a session, `/handoff` and `/braindump` route to the session tracker body in `work-sessions/{name}/session.md` rather than creating new shared-context files. Outside of a session, they land in `shared-context/{user}/`.

User-scoped files persist across work sessions. They are your ongoing reference material — naming ideas, sabbatical plans, competitive analysis. They stay until you promote them, move them, or delete them.

## How Context Gets Created

Three capture skills feed the shared context system. Each serves a different purpose:

**`/handoff`** captures workstream state — what was done, what is in progress, what comes next. It is structured and actionable. When called during an active work session, it updates the session tracker's body at `work-sessions/{name}/session.md` rather than creating a new file. Use it when someone (including your future self) needs to pick up where you left off.

**`/braindump`** captures reasoning and exploration — why a decision was made, what alternatives were considered, what the tradeoffs are. It is more freeform than a handoff. Use it when the conversation produced insights worth preserving, even if no code was written. The signal to braindump is hearing "we decided..." — that phrase means a decision just happened.

**`/aside`** captures drive-by ideas without interrupting the current work. It dispatches a background agent to research and expand on the idea while you continue working. Use it when a thought crosses your mind that does not belong in the current session but should not be lost.

All three default to user-scoped context for standalone captures. During active work sessions, `/handoff` and `/braindump` route to the session tracker body so the captured reasoning becomes part of the session's durable thinking — synthesized into release notes by `/complete-work` when the session finishes.

## The Promotion Lifecycle

Context flows upward through the levels over time:

```
User-scoped (personal) → Root (team-visible) → Locked (always-loaded)
```

The `/promote` skill manages this flow. It scans your personal context — auto-memory, local-only files, user-scoped ephemerals — and presents candidates with recommendations. You choose what to promote, what to keep personal, and what to discard.

Promotion to locked is a high bar. The question is: "Does the team need this on every single session?" If the answer is not a clear yes, the content stays ephemeral. Project status summaries belong in locked. A braindump about one feature's design tradeoffs does not.

The `/release` skill provides the other path to locked. When you cut a release, it synthesizes unreleased branch notes and open ephemerals into concise locked entries. This is how accumulated session knowledge gets distilled into durable team truths.

After a release, the cleanup pattern runs: ephemerals that were synthesized into locked get removed. Ephemerals that are still relevant stay as user-scoped reference. The workspace does not accumulate indefinitely — the release cycle is the natural cleanup mechanism.

## Ephemeral Locked Context

Locked does not mean permanent. Locked means positioned for maximum attention.

You can place temporary files in `shared-context/locked/` using the `local-only-` prefix. These files are gitignored (so they do not affect the team) but occupy the locked position in your local context. Use this for time-bound reminders, active risk warnings, or anything you need front-of-mind for a period.

```
shared-context/locked/
├── project-status.md              # Team truth — tracked in git
├── cross-platform.md              # Team truth — tracked in git
└── local-only-sabbatical-plan.md  # Personal, temporary — gitignored
```

The mental model: locked controls placement (front of context, maximum attention). Git tracking controls permanence (shared and versioned vs local and disposable). The two dimensions are independent.

## Naming and Organization

Shared context files follow naming conventions rather than a directory hierarchy:

- Handoffs and braindumps: named by topic, no date prefix (frontmatter has `updated:` for timestamps)

Session-scoped files live in `work-sessions/{name}/`, not in shared-context:

- Session trackers: `work-sessions/{name}/session.md`
- Specs: `work-sessions/{name}/design-{topic}.md`
- Plans: `work-sessions/{name}/plan-{topic}.md`

The principle is one topic per file. A handoff about authentication and a braindump about database migration are two files, not two sections in one file. Different topics have different lifecycles, different audiences, and different promotion paths. Keeping them separate means each can be promoted, archived, or deleted independently.

If you cannot name a file cleanly, you are probably conflating topics. The name forces clarity.

---

## Key Takeaways

- Shared context is markdown files in git — no database, no external service.
- Three levels: locked (always loaded, <10KB budget), root (team-visible), user-scoped (personal default).
- `/handoff`, `/braindump`, and `/aside` are the capture skills that feed shared context.
- Content flows upward via `/promote` and `/release` — ephemeral knowledge gets distilled into team truths.
- Locked means positioned for attention, not permanent. Use `local-only-` files in locked for temporary front-of-mind content.
