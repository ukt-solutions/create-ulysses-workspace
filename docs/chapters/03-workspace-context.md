# Workspace Context

Workspace context is the workspace's memory system. It is where team knowledge lives, where work-in-progress reasoning accumulates, and where decisions are recorded for future sessions. It lives in `workspace-context/`, and nearly everything there is a markdown file tracked in git — which means it is versioned, shareable, and survives workstation switches.

This chapter explains the three levels of `workspace-context/`, how each one reaches Claude, how content gets created, and how it flows through the promotion lifecycle.

---

## Everything Is a File

The workspace has no database, no API, no external service for context storage. Workspace context is a directory of markdown files. Claude reads them. Hooks inject them. Skills create and consume them. Git tracks them.

This design is deliberate. Files are portable, diffable, and readable by humans and AI alike. A new team member can browse `workspace-context/` and understand the project's accumulated knowledge without any special tooling. A subagent can be given team context by reading files from a directory. The simplicity of "it's just files" is load-bearing.

Each file has YAML frontmatter that declares its metadata:

```yaml
---
state: ephemeral
lifecycle: active
type: braindump
topic: auth-redesign
description: Why the auth layer was redesigned, and which alternatives were set aside
author: alice
updated: 2026-04-05
---
```

The frontmatter fields serve different consumers. `state` tells the system whether this file is ephemeral (temporary, evolving) or locked (team truth, always loaded). `lifecycle` tracks whether the content is active or resolved. `type` categorizes the content — braindump, handoff, research, promoted. `topic` names what the file is about. `description` is the one-line summary the generated catalogs list, so a session can tell whether a file is worth opening. `author` and `updated` track provenance.

## Three Levels

`workspace-context/` has three levels, each with a different scope and lifecycle:

### Canonical — Team Truths

`workspace-context/shared/locked/` contains knowledge that the entire team needs on every session. These files are concatenated, verbatim, into `workspace-context/canonical.md`, which CLAUDE.md imports — so they are read into Claude's context on every turn. The subagent-start hook passes them to every subagent as well.

Canonical context is the highest-attention position in the workspace. Content placed here gets maximum visibility: Claude reads it first, it survives context compaction longest, and subagents receive it even though they have no conversation history.

Because of this prominence, canonical context has a target size: `/workspace-init` aims to keep it under 10KB in total. Every file there is paid for on every turn, so it earns its place by being something the whole team needs constantly — project status, architectural decisions that affect daily work, active risk warnings, team coding standards. A braindump about one feature's design tradeoffs does not belong here.

Two enforced ceilings sit above that target, both set in `workspace.json`. `workspace.alwaysLoadedBudgetBytes` covers everything read at launch — CLAUDE.md, its imports and the active rules — and `workspace.canonicalBudgetBytes` covers `canonical.md` alone. [Chapter 4](04-claude-md.md) explains both.

### Shared — Team-Visible Working Documents

`workspace-context/shared/`, outside `locked/`, contains files that are visible to the whole team but not loaded automatically. These are working documents: milestone trackers, research findings, design explorations, product inventories. Each one gets a line in `workspace-context/index.md` — its path and its description — so a session knows it exists and can read it when it matters.

Shared-level files are an explicit choice. Content lands here when you deliberately want the team to see it — a cross-team handoff, a research summary that multiple people will reference, a planning document. The default destination for captures is personal, not shared.

### Personal — One Person's Working Context

`workspace-context/team-member/{user}/` contains one person's working context. This is the default destination for standalone captures: braindumps, handoffs, research, personal notes. Each file gets a line in a per-user index at `team-member/{user}/index.md`, which only that person's sessions load.

Personal files persist from one piece of work to the next. They stay until you promote them, move them, or delete them.

In-flight work state — a session's tracker, a task's specs and plans — never lives in `workspace-context/`. That is for knowledge that outlives any single effort. A session keeps its state in `work-sessions/{name}/`, and a task keeps it in its chat's drawer under `workspace-scratchpad/chats/{chat}/`. The capture skills route around this on their own; [how context gets created](#how-context-gets-created) shows how.

## How the Levels Reach Claude

The levels differ less in where their files sit than in how those files are loaded:

- **Canonical** loads in full, into every session. CLAUDE.md imports `@workspace-context/canonical.md`.
- **Shared** loads as an index, not as content. CLAUDE.md imports `@workspace-context/index.md`, which carries one line per file.
- **Personal** loads as an index for its owner only. The gitignored `CLAUDE.local.md` imports `@workspace-context/team-member/{user}/index.md`.

`canonical.md` and the two indexes are generated by `.claude/scripts/build-workspace-context.mjs` from the files on disk, and a hand edit to any of them is overwritten on the next run. To change what they say, change the source file — or its `description:` frontmatter — and regenerate. Gitignored files and `local-only-*` drafts are left out, and a `workspace-context/.indexignore` file can exclude further paths from the index by prefix.

## How Context Gets Created

Three capture skills write workspace context. Each serves a different purpose.

**`/handoff`** captures workstream state — what was done, what is in progress, what comes next. It is structured and actionable. Use it when someone, including your future self, needs to pick up where you left off.

**`/braindump`** captures reasoning and exploration — why a decision was made, what alternatives were considered, what the tradeoffs are. It is more freeform than a handoff. Use it when the conversation produced insights worth preserving, even if no code was written. The signal to braindump is hearing "we decided..." — that phrase means a decision just happened.

**`/aside`** captures a drive-by idea without interrupting the current work. Use it when a thought crosses your mind that does not belong to the current work but should not be lost.

Where `/handoff` and `/braindump` write depends on where you are:

| Where you are | What they write |
|---|---|
| Inside a session's workspace worktree | The session tracker's body, at `work-sessions/{name}/workspace/session.md`, committed on the session branch |
| In a chat under the task model (`workspace.sessionModel` is `"task"`) | A file in that chat's drawer, `workspace-scratchpad/chats/{chat}/` — gitignored and machine-local |
| At the workspace root in any other case | A standalone file in `workspace-context/team-member/{user}/` |

Under a session, the captured reasoning becomes part of the session's durable thinking, and `/complete-work` carries it into the PR body when the session finishes. Under a task, `/complete-work` lists the drawer and asks what deserves to move into `workspace-context/`.

A standalone file is written through `.claude/scripts/capture-context.mjs`, which works out the path, applies the type prefix and adds the frontmatter, so the skills cannot drift from one another. `/handoff` and `/braindump` each take an optional name (`/handoff auth` gives `handoff_auth.md`); with no name, the skill looks at the conversation and suggests one. Personal is the default scope. Say so if you want the file team-visible instead.

`/aside` is different in two ways: it ignores the lifecycle, and it is always personal. By default it dispatches a background agent to research the idea while you keep working; `--quick` parks the thought as a note without the research step. Either way the result is a gitignored `local-only-` file in `workspace-context/team-member/{user}/`. It is never committed, and it takes no part in a session. It stays there until `/promote` moves it.

## The Promotion Lifecycle

Context flows upward through the levels over time:

```
Personal (team-member/{user}/) → Shared (team-visible) → Canonical (loaded every session)
```

The `/promote` skill manages this flow. It scans three sources — your auto-memory, `local-only-*.md` files under `workspace-context/`, and `local-only-*.md` rules — and presents every candidate in one table, each with an assessment and a recommendation. You answer in codes: promote these, drop those, keep the rest. For each file you promote, you choose the destination: team-visible in `shared/`, personal in `team-member/{user}/`, or canonical in `shared/locked/`.

Promotion to canonical is a high bar. The question is: "Does the team need this on every single session?" If the answer is not a clear yes, the content stays ephemeral. Project status summaries belong in canonical. A braindump about one feature's design tradeoffs does not.

The template's memory-guidance rule sharpens that question. If Claude read the file for the first time, in a session about something unrelated, would it help frame the problem correctly, or would it push toward a particular answer to a question that has not been asked yet? The first is canonical. The second belongs in `shared/` at most, and more often in `team-member/{user}/`. The `/context-placement` skill walks through the whole routing decision.

Promotion is one-way: nothing in `/promote` demotes canonical content back to a local draft. A release does not promote either. `/release` touches workspace context in one step only — it offers to update any release state the workspace keeps there, such as a current-release line in a status file under `shared/locked/`, and it does so through a task worktree and PR rather than by editing the launcher.

The workspace still does not accumulate indefinitely. `/maintenance` flags stale context in its cleanup pass, and `/promote` recommends dropping files that are stale or that duplicate a rule.

## Local-Only Files

Locked does not mean permanent, and tracked does not mean shared. Two things about a file are independent: where it sits, which decides how much attention it gets, and whether git tracks it, which decides whether it is shared.

A `local-only-` prefix keeps a file out of git — the workspace `.gitignore` covers `local-only-*`. That makes it the right shape for a draft, or a machine-specific note, that should travel the same path as its tracked neighbours without being committed.

What the prefix does not do is get a file loaded. The generated `canonical.md` and indexes skip gitignored files, and the subagent-start hook skips them as well, so a `local-only-` file dropped into `shared/locked/` reaches neither the session nor its subagents. The filter is deliberate: it is what keeps a private note from being published to the repo or broadcast to every session.

```
workspace-context/shared/locked/
├── project-status.md              # Team truth — tracked in git, loaded every turn
├── cross-platform.md              # Team truth — tracked in git, loaded every turn
└── local-only-dev-environment.md  # Personal — gitignored, and left out of canonical.md
```

To keep a personal note in the context window, import it explicitly. CLAUDE.md can carry an `@`-reference to any file, tracked or not, and the template relies on that: its Workspace Config section imports `@local-only-template-freshness.md`, the gitignored template-freshness banner that the version-freshness-check hook maintains. The same mechanism suits a time-bound reminder you want front-of-mind for a while. Add the reference, and remove it once the note has served its purpose.

## Naming and Organization

Workspace context follows naming conventions rather than a directory hierarchy. A file's name says what it is:

| Written by | Filename |
|---|---|
| `/braindump` | `braindump_{topic}.md` |
| `/handoff` | `handoff_{topic}.md` |
| `/aside` | `research_{topic}.md`, or `braindump_{topic}.md` with `--quick` |
| `/promote` | keeps the source file's prefix |

These type prefixes apply to the working documents under `shared/` and `team-member/{user}/`. Files in `shared/locked/` use bare names, because the location already says what they are. A draft adds the `local-only-` prefix to stay gitignored until it is promoted. Topics are named without a date prefix; the frontmatter has `updated:` for timestamps.

In-flight artifacts are named by the work they belong to, and they do not go in `workspace-context/`:

- A session keeps its tracker at `work-sessions/{name}/workspace/session.md`, with its spec as `design-{topic}.md` and its plan as `plan-{topic}.md` beside it.
- A task uses the same `design-{topic}.md` and `plan-{topic}.md` names, in its chat's drawer at `workspace-scratchpad/chats/{chat}/`.

The principle behind both is one topic per file. A handoff about authentication and a braindump about database migration are two files, not two sections in one file. Different topics have different lifecycles, different audiences, and different promotion paths. Keeping them separate means each can be promoted, archived, or deleted independently.

If you cannot name a file cleanly, you are probably conflating topics. The name forces clarity.

## When You Don't Want Preservation

Not every file should be tracked. Sometimes you genuinely want disposable scratch space — output you will read once and discard, debug logs from a one-off troubleshoot, intermediate analysis you do not want cluttering git history.

`workspace-scratchpad/` is the answer. It is gitignored, lazy-created, and lives at the workspace root. Hooks write debug output here. Skills drop intermediate state here. You can drop comparison files, scratch notes, or experimental snippets here when you do not need them to survive a workstation switch.

The split is simple:

- **Should it outlive this machine?** → `workspace-context/` (tracked in git)
- **Will I read it once and discard?** → `workspace-scratchpad/` (gitignored)

A spec or plan belongs to the work it serves, so it goes in that work's own area — the session worktree or the task's drawer — rather than in `workspace-context/`. When the work completes, `/complete-work` offers to promote whatever deserves to outlive it.

That makes one corner of the scratchpad worth more than the rest. A task's drawer is machine-local and backed up nowhere, and the session log, `session-log.jsonl`, is a history no other file keeps. Promote what matters before you retire a machine.

---

## Key Takeaways

- Workspace context is markdown files in git — no database, no external service.
- Three levels under `workspace-context/`: `shared/locked/` (canonical, loaded every session), `shared/` (team-visible), `team-member/{user}/` (personal, and the default).
- Canonical loads in full through the generated `canonical.md`; the other two levels load as generated indexes.
- `/handoff`, `/braindump` and `/aside` are the capture skills. The first two follow the lifecycle in play — session tracker, task drawer or standalone file. `/aside` always writes a personal `local-only-` file.
- Content flows upward through `/promote`. Promotion to canonical is a high bar.
- A `local-only-` file is never loaded by the generated catalogs; import it from CLAUDE.md if you want it in the window.
- For things you genuinely do not want preserved, use `workspace-scratchpad/` — gitignored and lazy-created.
