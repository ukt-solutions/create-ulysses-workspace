# Skills

Skills are workflow commands that you invoke by name. Each skill is a markdown file that defines a multi-step process — how to start a work session, how to finalize a branch, how to capture context. When you type `/start-work`, Claude reads the skill file and follows its instructions. Skills are the verbs of the workspace.

This chapter covers what skills are, how they work, and what each one does.

---

## How Skills Work

A skill is a markdown file at `.claude/skills/{name}/SKILL.md`. Unlike rules, which are loaded on every turn, skills are loaded on demand — only when you invoke them. This keeps the always-loaded context small while making complex workflows available when needed.

When you invoke a skill, Claude reads the SKILL.md file and follows its instructions step by step. The skill may read files, run commands, ask you questions, and make decisions based on the workspace state. When the workflow completes, the skill's instructions are no longer actively loaded.

Skills are tracked in git, so the team shares the same workflow definitions. CLAUDE.md lists the available skills as a quick reference, but the authoritative definition is always the SKILL.md file.

## Capture Skills

These skills create shared context — they turn conversation knowledge into persistent files.

### /handoff

Saves workstream state: what was done, what is in progress, what comes next. Structured and actionable. During an active work session, it updates the session tracker rather than creating a new file.

**When to use it:** You are stopping work and someone (including future you) needs to know where things stand. You finished a chunk of work and want to record the state before moving on.

**What it produces:** An updated session tracker (during a session) or a new user-scoped context file (outside a session).

### /braindump

Captures reasoning, exploration, and design rationale. More freeform than a handoff — designed for "why we chose X" content. During an active work session, it appends to the session tracker.

**When to use it:** The conversation produced a decision worth preserving. You discussed tradeoffs, explored alternatives, or settled on an approach. The signal is hearing "we decided..." — that means a decision just happened.

**What it produces:** Reasoning content added to the session tracker (during a session) or a new braindump file (outside a session).

### /aside

Captures a drive-by idea without interrupting the current work. Dispatches a background agent to research and expand on the idea while you continue working. Use `--quick` for a simple note without the research step.

**When to use it:** A thought crosses your mind that does not belong in the current session. An interesting pattern you noticed. A feature idea that should be explored later.

**What it produces:** A shared context file with the original idea and (unless `--quick`) agent research findings.

## Lifecycle Skills

These skills manage work sessions — starting, pausing, completing, and backing up.

### /start-work

Begins or resumes a work session. With no arguments, it checks for existing sessions and offers to resume or start new. `/start-work blank` skips straight to creating a new session. `/start-work handoff` shows available handoffs to resume from.

**The creation flow:** You describe what you are working on, choose which repos to include, confirm the branch name. The skill runs `create-work-session.mjs` to create the `work-sessions/{name}/` folder with a workspace worktree, nested project worktrees, and the unified session tracker (`session.md`).

**The resume flow:** You pick an existing session. The skill verifies worktrees exist, registers the current chat in the session tracker's `chatSessions` frontmatter, and reconstructs any uncaptured history from previous conversations.

### /pause-work

Suspends the active work session. Captures the current state to the session tracker, pushes all branches, creates draft pull requests, and marks the session as paused. The worktrees stay in place — the session is meant to be resumed.

**When to use it:** You are stopping for the day, switching to something else, or stepping away. You want your work backed up and visible but not finalized.

### /complete-work

Finalizes the active work session. This is the most complex skill — it handles the full completion pipeline:

1. Rebases all project repos against their default branches
2. Offers a final braindump to capture remaining discussion
3. Gathers all source material (session tracker, specs, plans, handoffs, commit logs)
4. Synthesizes release notes from the gathered material
5. Consumes branch-scoped specs and plans
6. Pushes all repos
7. Creates pull requests for all project repos plus the workspace
8. Presents a unified summary with "Merge all?" prompt
9. Merges atomically and cleans up worktrees

**When to use it:** The work is done. You are ready to merge and move on.

### /sync-work

Pushes current branches to remote for all repos. No PRs, no lifecycle changes, no forced context capture. The lightest-touch backup — just pushes commits.

**When to use it:** You want to back up your work without any ceremony. You are still actively working and just want a checkpoint.

**The three intents:**

| Skill | Intent | What happens |
|---|---|---|
| /pause-work | Stopping, someone might pick up | Capture + push + draft PR + mark paused |
| /complete-work | Done with this branch | Synthesize + push + real PR + merge |
| /sync-work | Still working, just backing up | Push only |

## Admin Skills

These skills handle workspace management, promotion, and releases.

### /promote

Moves personal knowledge into shared context. Scans auto-memory, local-only files, and user-scoped context. Presents candidates with assessments and recommendations. You choose what to promote (to team-visible), what to keep personal, and what to discard.

### /release

Combines unreleased branch release notes into a versioned release document. Archives the consumed branch notes. Synthesizes ephemeral shared context into locked entries where appropriate. This is a project repo operation — each repo has its own release cadence. See [Chapter 9](09-the-release-cycle.md) for the full flow.

### /maintenance

Audits workspace health and recommends cleanup. Checks cross-reference consistency, frontmatter integrity, workspace structure, and git state. Identifies stale context, orphaned worktrees, and contradictions between files. Run periodically or before a release to catch drift.

### /workspace-init

First-time workspace initialization — the single post-scaffold skill. Handles everything needed to make a workspace operational: clones repos from the workspace manifest, installs template components from the staged payload, activates optional rules, configures user identity, extracts team knowledge from documentation sources and prior Claude chat history, formalizes existing worktrees as work sessions, populates shared context, and sets up the workspace remote. Works on a branch (`chore/workspace-init`) so the user can review all changes before merging. Also handles team member onboarding — connecting to an existing workspace repo with rebase and conflict resolution.

### /workspace-update

Applies a staged template update. When the CLI's `--upgrade` command stages new files to `.workspace-update/`, this skill applies them interactively. Runs maintenance before and after to catch any drift the update introduces. See [Chapter 10](10-installation-and-upgrades.md) for the upgrade flow.

## How Skills Chain Together

Skills are independent, but they form a natural workflow:

```
/start-work
    ↓
  work, commit, iterate
    ↓
  /braindump or /handoff (as decisions happen)
    ↓
  /sync-work (backup checkpoints)
    ↓
  /pause-work (if stopping) ← → /start-work (resume later)
    ↓
  /complete-work (when done)
    ↓
  /release (when cutting a version)
    ↓
  /maintenance (periodically)
```

No skill requires another skill to have run first (except /complete-work, which expects an active session). The chaining is a natural workflow, not enforced coupling.

---

## Key Takeaways

- Skills are on-demand workflow commands loaded when invoked, not on every turn.
- Capture skills (/handoff, /braindump, /aside) create shared context from conversation knowledge.
- Lifecycle skills (/start-work, /pause-work, /complete-work, /sync-work) manage work sessions.
- Admin skills (/promote, /release, /maintenance, /workspace-init, /workspace-update) handle workspace management.
- Skills chain into a natural workflow but are not coupled — each can run independently.
