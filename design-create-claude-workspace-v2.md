# create-claude-workspace — Design Spec v2

**Date:** 2026-04-01
**Status:** Draft
**Authors:** Myron Davis, Claude
**Supersedes:** v1 (deleted — consumed into release notes and this document)

---

## 1. Overview

A convention-over-configuration workspace template for Claude Code that replaces external dependencies (Notion, custom MCP servers) with native file-based primitives. Ships as an `npx create-claude-workspace` scaffolder and a forkable template repo.

### Philosophy

- Everything Claude needs is in the file system
- Everything a team shares is in git
- Convention over configuration — naming conventions do the heavy lifting
- Hooks where automation provides hard-to-replicate value, explicit skills everywhere else
- Zero external runtime dependencies

### Three Layers

| Layer | Purpose | Persistence |
|-------|---------|-------------|
| **Template** (upstream) | Generic structure, default rules, skills, agents | npm package / GitHub repo |
| **Team workspace** (forked/customized) | Project-specific rules, shared context, repo manifest | Git repo, committed |
| **Personal** (gitignored) | Local settings, personal rules, auto-memory | Machine-local |

Works for solo developers (layers 1+3) and teams (all three). Portability across workstations by cloning the workspace repo.

### Terminology

- **Chat session** — a single conversation in Claude Code. Ends when you exit or it compacts. Has a session ID.
- **Work session** — the lifecycle from `/start-work` to `/complete-work`. Spans multiple chat sessions. Tied to a branch and worktree.

All skills and docs should use "work session" consistently. Avoid bare "session" which is ambiguous.

---

## 2. Directory Structure

```
my-project/                              # Workspace repo (git init'd)
├── CLAUDE.md                             # Root instructions + @-imports
├── workspace.json                        # Workspace shape config
├── .gitignore
│
├── .claude/                              # Claude config
│   ├── settings.json                     # Team settings (committed)
│   ├── settings.local.json               # Personal overrides (gitignored)
│   ├── hooks/
│   │   ├── session-start.sh              # SessionStart hook
│   │   ├── subagent-start.sh             # SubagentStart hook
│   │   ├── pre-compact.sh                # PreCompact hook
│   │   └── post-compact.sh               # PostCompact hook
│   ├── rules/
│   │   ├── workspace-structure.md        # Mandatory
│   │   ├── git-conventions.md            # Mandatory
│   │   ├── coherent-revisions.md         # Mandatory
│   │   ├── honest-pushback.md            # Mandatory
│   │   ├── cloud-infrastructure.md.skip  # Optional
│   │   ├── superpowers-workflow.md.skip  # Optional
│   │   ├── documentation.md.skip         # Optional
│   │   ├── memory-guidance.md.skip       # Optional
│   │   └── local-only-*.md              # Personal (gitignored)
│   ├── agents/
│   │   ├── implementer.md
│   │   ├── researcher.md
│   │   └── reviewer.md
│   └── skills/
│       ├── setup/SKILL.md
│       ├── start-work/SKILL.md
│       ├── handoff/SKILL.md
│       ├── braindump/SKILL.md
│       ├── pause-work/SKILL.md
│       ├── complete-work/SKILL.md
│       ├── promote/SKILL.md
│       ├── release/SKILL.md
│       ├── sync/SKILL.md
│       └── audit/SKILL.md
│
├── shared-context/                       # Shared memory (committed)
│   ├── locked/                           # Team truths — loaded every session
│   ├── *.md                              # Team-visible ephemerals (explicit choice)
│   ├── {user}/                           # User-scoped ongoing context (default)
│   │   ├── *.md                          # Ongoing — persists across work sessions
│   │   └── inflight/                     # Current work session artifacts
│   │       ├── design-*.md               # Branch-scoped specs
│   │       ├── plan-*.md                 # Branch-scoped plans
│   │       └── *.md                      # Session braindumps and handoffs
│   └── local-only-*.md                   # Personal (gitignored)
│
├── repos/                                # Project repos (all gitignored)
│   ├── .keep
│   ├── codeapy/                          # Cloned repo (stays on default branch)
│   └── codeapy___wt-ble-provisioning/    # Worktree
│
└── .claude-scratchpad/                   # Truly disposable (all gitignored)
    └── .keep
```

### Release Notes (in each project repo, not workspace)

```
repos/codeapy/release-notes/
├── unreleased/
│   ├── branch-release-notes-a1b2c3d.md
│   └── branch-release-questions-a1b2c3d.md
├── archive/v1.2.0/                       # Raw branch notes preserved
├── v1.2.0.md
└── v1.0.0.md
```

---

## 3. Universal File Convention

Three states, zero tooling — naming conventions do all the work:

| Pattern | Committed? | Loaded by Claude? | Use case |
|---------|-----------|-------------------|----------|
| `name.md` | Yes | Yes | Active + shared |
| `name.md.skip` | Yes | No | Available + inactive |
| `local-only-name.md` | No | Yes | Active + personal |

This convention applies universally across `.claude/rules/` and `shared-context/`.

To activate a skipped file: rename, drop the `.skip` suffix.
To add a personal file: prefix with `local-only-`.
To deactivate a mandatory rule locally: delete or rename to `.skip` (don't push).

---

## 4. Shared Context & Knowledge Lifecycle

### Four Levels

| Level | What lives there | Default? |
|-------|-----------------|----------|
| `locked/` | Team truths — always loaded, injected into subagents | Promoted by /release |
| Root | Team-visible ephemerals — cross-team handoffs, post-release leftovers | Explicit choice |
| `{user}/` | Ongoing personal context — persists across work sessions | Default for captures |
| `{user}/inflight/` | Current work-session artifacts — consumed by /complete-work | Created by /start-work |

User-scoped is the default. Root is only for content deliberately made team-visible.

### Context File Format

All shared-context files use frontmatter:

```yaml
---
state: ephemeral          # ephemeral | locked (knowledge persistence)
lifecycle: active         # active | paused | resolved (work state, ephemeral only)
type: handoff             # handoff | braindump | promoted | synthesized
topic: auth-refactor
branch: feature/auth-token-refresh
repo: codeapy
author: myron
updated: 2026-04-01
---
```

**Frontmatter fields:**
- `state` — knowledge persistence: `ephemeral` (working, may be consumed) or `locked` (team truth, always loaded)
- `lifecycle` — work state (ephemeral files only): `active` (in progress), `paused` (suspended via /pause-work), `resolved` (completed via /complete-work, awaiting /release synthesis)
- `type` — how it was created: `handoff`, `braindump`, `promoted`, `synthesized`
- `topic` — human-readable name, used for grouping and display
- `branch` / `repo` — git references (optional, set by /handoff when workstream-linked)
- `author` — user who created it
- `updated` — last modification date (ISO 8601)

### Naming Conventions

- Specs: `design-{topic}.md`
- Plans: `plan-{topic}.md`
- Handoffs and braindumps: named by topic (no date prefix — use frontmatter `updated:`)
- Named by topic, not by date. Frontmatter has `updated:` for timestamps.

### Spec Scoping

| Scope | Lives where | Consumed when |
|-------|-------------|---------------|
| **Branch-scoped** (spec for one feature) | `{user}/inflight/` or worktree | /complete-work for that branch |
| **Project-scoped** (spec for the whole system) | `{user}/` ongoing | /release when the project ships a version |

### Knowledge Lifecycle

```
Auto-memory (personal, automatic)
    │
    ├── /promote → shared-context/ (ephemeral or locked)
    │
/braindump → shared-context/{user}/ (ephemeral) — discussion capture
/handoff   → shared-context/{user}/ (ephemeral) — workstream state
    │
    ├── /pause-work uses both (state + discussion)
    ├── /complete-work does /braindump (captures final discussion)
    │
    ▼
/release synthesizes:
  - Merge ephemeral into existing locked (enrich)
  - Combine related ephemerals into new locked
  - Move unresolvable ephemerals to user-scoped ongoing
  - Discard consumed/stale ephemerals
```

### Post-Release Ephemeral Lifecycle

After `/release`, root ephemerals either:
- Get synthesized into `locked/` (team truth)
- Move to `{user}/` ongoing (author's reference)
- Stay as root ephemeral (still relevant, not yet lockable)
- Get discarded (fully consumed)

User-scoped ephemerals after release: keep as-is, `/promote` to locked, or rename to `local-only-*` to privatize.

### Local-Only and Shared

Every context-creating skill (`/handoff`, `/braindump`, `/promote`) asks at creation time:
- **Shared** — committed, visible to team (root `shared-context/`)
- **User-scoped** — committed under `shared-context/{user}/` (default)
- **Local-only** — prefixed `local-only-*`, gitignored
- **Mixed** — some files shared, some local, in the same operation

---

## 5. CLAUDE.md

Thin orchestrator — delegates to rules via @-imports, minimal inline content:

```markdown
## Workspace: {{project-name}}

This is a claude-workspace. All conventions are defined in .claude/rules/.

## Quick Reference
- Repos live in `repos/`, worktrees use `___wt-` suffix
- Scratch files go in `.claude-scratchpad/`
- Shared memory lives in `shared-context/`
- No files outside `repos/`, `shared-context/`, or `.claude-scratchpad/`

## Workspace Config
@workspace.json

## Team Knowledge (always loaded)
@shared-context/locked/

## Skills
- `/setup` — first-time workspace setup (clone repos, activate rules)
- `/start-work [handoff|blank]` — begin a work session
- `/handoff [name]` — save workstream state
- `/braindump [name]` — capture discussion/reasoning
- `/pause-work` — suspend work, push, draft PR
- `/complete-work` — finalize branch, release notes, real PR
- `/promote` — move personal memory to shared context
- `/release [version]` — combine unreleased notes into versioned doc
- `/sync` — push branches without ceremony
- `/audit` — check context integrity
```

---

## 6. workspace.json

Workspace shape config — separate from Claude's settings.json:

```json
{
  "workspace": {
    "name": "codeapy",
    "scratchpadDir": ".claude-scratchpad",
    "worktreeSuffix": "___wt-",
    "sharedContextDir": "shared-context",
    "releaseNotesDir": "release-notes",
    "subagentContextMaxBytes": 10240,
    "greeting": "Welcome back to codeapy.",
    "releaseMode": "per-repo"
  },
  "repos": {
    "codeapy": {
      "remote": "git@github.com:omnivativ/codeapy.git",
      "branch": "main",
      "primary": true
    }
  }
}
```

**Workspace fields:**
- `name` — workspace identifier
- `scratchpadDir` — truly disposable files only
- `worktreeSuffix` — `___wt-` separator for worktree directories
- `sharedContextDir` — shared memory directory name
- `releaseNotesDir` — where release notes live in project repos
- `subagentContextMaxBytes` — size cap for SubagentStart hook context injection (default 10240)
- `greeting` — optional message shown at session start (via additionalContext)
- `releaseMode` — `per-repo` (default), `workspace` (combined), or `ask`

Personal repo overrides via `.claude/settings.local.json`:

```json
{
  "workspace": {
    "user": "myron",
    "localRepos": {
      "my-tools": {
        "remote": "git@github.com:myron/my-tools.git",
        "branch": "main"
      }
    }
  }
}
```

> **Note:** `workspace.localRepos` and `workspace.user` are custom keys — not native to Claude Code's settings schema. The hooks and skills read them alongside `workspace.json`. Claude Code ignores unknown keys in settings files.

---

## 7. Hooks

### Implemented Hooks

#### Hook 1: SessionStart

**Fires on:** startup, resume

**Behavior:**
1. Read `workspace.json` — parse workspace name, repo list
2. Check greeting setting — include in additionalContext if set
3. Clone missing repos, fetch existing ones
4. Surface latest shared-context entries (ephemeral) as a summary
5. Differentiate resume vs fresh start (via hook `reason` field):
   - **Resume:** surface where things left off, don't re-suggest /start-work if already formalized
   - **Fresh start:** full context scan, suggest /start-work handoff or blank
6. First run without repos? Suggest `/setup`

**Implementation:** Shell script. Scans shared-context/ to depth 3 (covers `{user}/inflight/`). Returns `additionalContext` JSON with greeting instruction and context summary.

#### Hook 2: SubagentStart

**Fires on:** any subagent spawn

**Behavior:**
1. Read all files in `shared-context/locked/`
2. Concatenate into a single context block
3. If total size exceeds `subagentContextMaxBytes`, inject a summary instead
4. Return as `additionalContext` JSON

#### Hook 3: PreCompact

**Fires on:** before context compression (auto or manual)

**Behavior:**
1. Read user identity from settings.local.json
2. Inject prompt suggesting /braindump or /handoff before context is lost
3. Reference the user's shared-context path so they know where captures go

#### Hook 4: PostCompact

**Fires on:** after context compression

**Behavior:**
1. Inject reminder that earlier context was compacted
2. Suggest capturing anything important that was discussed

### Planned Hooks

#### Repo-Write Detection (PreToolUse)

Detect writes to `repos/` without an active work session. When triggered:
- Check if a worktree/branch exists for the target repo
- If not: prompt user to formalize with /start-work
- Prevents accidental changes to default branches

#### Session Logging (SessionEnd)

Log session summary to `.claude-scratchpad/session-log.jsonl`:
```json
{"event": "session_end", "date": "2026-04-01T16:00:00", "user": "myron", "turns": 47, "tools_used": 83, "files_changed": 12, "captures": 2, "compacted": 1, "reason": "logout"}
```

#### Stale Worktree Detection (WorktreeCreate)

When creating a new worktree, scan for existing worktrees and flag stale ones.

### What's NOT Hooked

These are handled by skills when explicitly invoked:
- Commits, formatting, linting — project-specific tooling
- Worktree creation — `/start-work`
- Context file commits — `/handoff`, `/braindump` (auto-commit atomically)
- Release notes — `/complete-work` and `/release`

---

## 8. Rules

### Mandatory (4)

| Rule | Purpose |
|------|---------|
| `workspace-structure.md` | Directory layout, four-level shared-context, naming conventions, file placement |
| `git-conventions.md` | Branching (feature/, bugfix/, chore/), worktrees, commits (conventional format), no direct changes to default branch |
| `coherent-revisions.md` | Rewrite affected sections from start to finish, never patch/inject. Applies to all written output. |
| `honest-pushback.md` | Challenge assumptions, flag concerns, push back on bad ideas. No sycophancy. |

### Optional (.skip by default) (4+)

| Rule | Purpose |
|------|---------|
| `cloud-infrastructure.md.skip` | Code-first cloud changes, no hardcoded environment values |
| `superpowers-workflow.md.skip` | Research phase before implementation, subagent-driven development |
| `documentation.md.skip` | Doc-code consistency, no unsolicited docs |
| `memory-guidance.md.skip` | What to auto-remember, handoff/braindump suggestions |

### Planned Optional Rules

| Rule | Purpose |
|------|---------|
| `context-discipline.md.skip` | Heavily push handoffs/braindumps, suggest capture at breakpoints |
| `scope-guard.md.skip` | Detect and push back on scope creep, suggest splitting work |
| `token-economics.md.skip` | Token-aware model/effort suggestions, context waste detection |
| `agent-rules.md.skip` | Rules specifically governing agent behavior |

---

## 9. Ten Skills

### /setup
First-time workspace initialization. Clones repos, activates rules, configures user identity. Idempotent.

### /start-work [handoff | blank]
Begin a work session. Creates branches in BOTH the project repo (with worktree) AND the workspace repo. Supports retroactive formalization — can be called mid-session to catch up with work already done.

**No parameter:** checks for active context, asks whether to resume or start fresh.
**handoff:** lists ephemeral context, user picks which to resume.
**blank:** asks what you're working on, creates branch + worktree.

### /handoff [name]
Save workstream state. Structured format: status, key decisions, next steps, open questions. Asks: user-scoped (default), team-visible, or local-only. Auto-commits individually. Can split conflating topics into separate files.

### /braindump [name]
Capture discussion/reasoning. Freeform format: context, exploration, decisions, implications. Same scoping options as /handoff. Supports `/braindump side {name}` for unrelated ideas that shouldn't derail the current work.

### /pause-work
Suspend work — push both repos, create draft PR with [DRAFT] prefix, mark context as paused. Captures discussion (/braindump) and workstream state (/handoff) before pausing.

### /complete-work
Finalize branch — handles BOTH project repo and workspace repo:

**Project repo:**
1. Rebase onto parent branch
2. Read spec + plan + handoffs touched + commit log
3. Synthesize into `branch-release-notes-{commit_id}.md`
4. Collect open questions into `branch-release-questions-{commit_id}.md`
5. Remove consumed branch-scoped specs/plans
6. Push and create PR

**Workspace repo:**
1. Process inflight/ — resolve handoffs, move braindumps to ongoing or discard
2. Push workspace branch
3. Create workspace PR

If repo changes were made without a formal work session, asks: accept as work, stash for later, hand off to someone, or revert.

### /promote
Move personal auto-memory or local-only files into shared context. Rewrites terse auto-memory into proper shared-context format. Asks: locked or ephemeral, team-visible or user-scoped.

### /release [version]
Combine unreleased branch-release-notes into versioned release doc. Targets repos, not the workspace. Per-repo by default (configurable via `releaseMode` in workspace.json).

Also synthesizes workspace shared-context:
- Ephemeral → locked (enrich or create)
- Resolved inflight → cleanup
- Surface unresolved questions for decision

### /sync
Push without ceremony — both repos if both have changes. No PR, no status change, no forced capture. Optionally offers capture. Handles missing remotes by offering to create them.

### /audit
On-demand integrity check:
- Cross-reference shared-context files for contradictions and staleness
- Check memory files against shared-context
- Verify workspace-structure rule matches actual directory layout
- Verify CLAUDE.md references match actual skills/rules
- Check handoff frontmatter against actual git state
- Report gaps with specific file references

---

## 10. Three Template Agents

### researcher
- **Model:** Sonnet
- **Tools:** Read-only (Read, Glob, Grep, WebSearch, WebFetch, LSP)
- **Purpose:** Deep codebase and documentation research. Never changes code.
- **Context:** Locked shared-context via SubagentStart hook.

### implementer
- **Model:** Inherit
- **Tools:** All
- **Isolation:** Worktree
- **Purpose:** Focused single-task implementation. Full task description in prompt.
- **Escalation:** DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT

### reviewer
- **Model:** Opus
- **Tools:** Read-only + Bash (for tests)
- **Purpose:** Review against spec, conventions, quality. Finds problems, doesn't fix them.
- **Output:** PASS / PASS_WITH_NOTES / NEEDS_CHANGES

Teams add project-specific agents by dropping `.md` files into `.claude/agents/`. All inherit locked context via SubagentStart hook.

---

## 11. Workspace Branching

The workspace repo follows the same branch discipline as project repos. Multiple developers (or multiple work sessions) cannot push directly to main.

### Convention

`/start-work` creates branches in BOTH repos:
1. **Project repo:** branch + worktree (e.g., `repos/codeapy___wt-auth-refactor/`)
2. **Workspace repo:** branch (same name for traceability)

`/complete-work` PRs both repos. `/pause-work` pushes and draft-PRs both.

### Solo vs Team

**Solo:** Option C — branch workspace, worktree only project repos. One workspace branch at a time. Context-switch by committing and switching branches.

**Team:** Each member clones the workspace repo — each clone is already isolated. They branch, make changes, PR back to main. Standard git workflow.

### No-Remote Handling

Any skill that pushes (pause-work, complete-work, sync) must handle missing remotes:
1. Check `git remote -v`
2. If no remote: offer to create via `gh repo create` or ask for URL
3. Never silently skip push

---

## 12. Work Session Detection

### Repo Writes = No Longer Discussion

When file writes or git operations target `repos/`, the session has crossed from discussion to implementation. A PreToolUse hook (planned) detects this and prompts formalization.

### Retroactive Formalization

`/start-work` supports being called mid-session:
- Detects what's already happened (commits, files changed, context created)
- Creates branches and worktrees retroactively
- Links existing braindumps/handoffs to the work session

### Delegation Handoffs

If a user explored something during discussion:
- Create a team-visible handoff at root `shared-context/`
- Describes what was done, what remains, suggested approach
- SessionStart hook surfaces it: "Team handoff available: {topic} (from {author})"
- Another team member picks it up via `/start-work handoff`

---

## 13. Release Process

### Release Targets Repos, Not the Workspace

Workspaces don't have versions (except the scaffolder template itself). `/release` always targets project repos. Each repo has independent release cadence.

### /release Flow

1. Read `release-notes/unreleased/branch-release-notes-*.md` from target repo
2. Read `release-notes/unreleased/branch-release-questions-*.md`
3. Group by type (feature, fix, chore), surface unresolved questions
4. Synthesize into `release-notes/v{version}.md`
5. Archive unreleased files
6. Synthesize workspace shared-context (ephemeral → locked)
7. Commit both repos

### Multi-Repo Behavior

Controlled by `workspace.releaseMode`:
- **per-repo** (default) — process one repo at a time
- **workspace** — process all repos into one combined document
- **ask** — prompt each time

---

## 14. Context Integrity

### Capture-Time Cross-Check

After writing a new context file, scan existing files for:
- Stale references (paths, counts, status that changed)
- Contradictions (old info conflicts with new)
- Overlap (same topic in multiple files)

### /audit Skill

On-demand integrity check. Runs cross-references, reports gaps. Like a linter for shared knowledge.

### Compaction-to-Capture Ratio

Key health metric tracked via session logging:
- `> 80%` — system working
- `50-80%` — hooks helping but users sometimes dismiss
- `< 50%` — need stronger intervention

---

## 15. Analytics

### Session Logging

Each hook appends to `.claude-scratchpad/session-log.jsonl`. SessionEnd writes summary. Zero infrastructure.

### Anti-Pattern Metrics

| Category | Metrics |
|----------|---------|
| **Context hygiene** | Sessions without capture, compactions without saves, stale handoffs, locked bloat |
| **Cost & efficiency** | Token spend per session/skill/agent, wrong model choices, context waste |
| **Workflow health** | Branch lifecycle duration, handoff-to-resume ratio, scope creep signals, orphaned worktrees |
| **Team collaboration** | Solo vs shared ratio, promotion rate, cross-author reads, knowledge distribution |

---

## 16. The Scaffolder: npx create-claude-workspace

### Interactive Flow

Prompts for: workspace name, directory, repos, user name, optional rules to activate.

### Scaffolder Logic

1. Copy template files, replace `{{project-name}}` placeholders
2. Rename `_gitignore` → `.gitignore`
3. Populate `workspace.json` with repo manifest
4. Write `settings.local.json` with user identity
5. Rename selected `.md.skip` → `.md`
6. `git init` + initial commit
7. Clone repos

### Migration Support

Two entry points:
- `npx create-claude-workspace --migrate` — scaffolder flag for converting existing workspaces
- `/migrate` skill — for subsequent migrations or partial upgrades

### Tech Stack

Node.js CLI, `prompts` for interactive input. No runtime dependencies in the generated workspace.

---

## 17. .gitignore

```gitignore
# Repos (cloned separately per user)
repos/
!repos/.keep

# Scratchpad (truly disposable)
.claude-scratchpad/
!.claude-scratchpad/.keep

# Personal overrides
.claude/settings.local.json

# Local-only convention (rules, context)
.claude/rules/local-only-*
shared-context/local-only-*

# Claude Code internals
.superpowers/

# OS
.DS_Store
Thumbs.db
```

---

## 18. Documentation

Comprehensive user-facing documentation ships with the template. Covers:

- **Concepts:** workspace structure, file conventions, knowledge lifecycle, three layers, four-level shared-context
- **Skills:** one doc per skill (10 total) with walkthroughs and examples
- **Agents:** overview, each agent, creating custom agents
- **Configuration:** workspace.json, settings.json, rules, hooks
- **Guides:** team onboarding, solo workflow, migration, customization
- **Reference:** file format schemas, workspace.json schema
- **Behavioral patterns:** "how to hold the tool" — one topic per file, name before writing, rewrite not append, braindump when you hear "we decided", keep locked context lean

---

## 19. Implementation Considerations

### Open Questions

See `release-notes/unreleased/branch-release-questions-6322a80.md` for the consolidated list from v1 development.

### Risks

- **Context size creep:** The `/complete-work` → `/release` pipeline is the natural pressure valve. `/release` consolidates locked entries. SubagentStart hook has a size cap.
- **Merge conflicts in shared-context:** User-scoped directories reduce collision. Context files committed individually. Workspace branching prevents direct-to-main conflicts.
- **Template drift:** Keep template minimal. Teams cherry-pick skill/agent updates.

### What Changed from v1

1. Four-level shared-context (locked / root / user / user/inflight)
2. User-scoped is the default, not root
3. inflight/ vs ongoing distinction
4. 4 mandatory rules (added coherent-revisions, honest-pushback)
5. 4 hooks (added PreCompact, PostCompact)
6. Scratchpad redefined as truly disposable
7. Naming prefixes (design-*, plan-*)
8. Post-release ephemeral lifecycle
9. Work session detection and retroactive formalization
10. Delegation handoffs
11. Session resume vs fresh start differentiation
12. /sync skill
13. /audit skill
14. Context integrity cross-checking
15. Analytics and session logging
16. Work session vs chat session terminology
17. Workspace branching (workspace repo needs branch discipline too)
18. /complete-work handles both project repo and workspace repo
19. Release targets repos not workspace, per-repo by default
20. Stale worktree detection
