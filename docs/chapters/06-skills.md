# Skills

Skills are workflow commands that you invoke by name. Each skill is a markdown file that defines a multi-step process — how to start work, how to finalize a branch, how to capture context. When you type `/start-work`, Claude reads the skill file and follows its instructions. Skills are the verbs of the workspace.

This chapter covers what skills are, how they work, and what each of the seventeen the template ships does.

---

## How Skills Work

A skill is a markdown file at `.claude/skills/{name}/SKILL.md`. An unconditional rule is loaded on every turn; a skill is not. Only the skill's one-line `description` sits in the context from the start, which is how Claude knows the skill exists. The body is read when you invoke it. This keeps the always-loaded context small while making complex workflows available when needed.

When you invoke a skill, Claude reads the SKILL.md file and follows its instructions step by step. The skill may read files, run commands, ask you questions, and make decisions based on the workspace state. When the workflow completes, the skill's instructions are no longer actively loaded.

Skills are tracked in git, so the team shares the same workflow definitions. CLAUDE.md lists the available skills as a quick reference, but the authoritative definition is always the SKILL.md file.

## The Seventeen Skills

Every skill has its own entry in this chapter, in four groups:

| Skill | Group | What it does |
|---|---|---|
| `/handoff` | Capture | Save workstream state |
| `/braindump` | Capture | Capture reasoning and design rationale |
| `/aside` | Capture | Park a drive-by idea without interrupting your work |
| `/start-work` | Lifecycle | Begin or resume work |
| `/pause-work` | Lifecycle | Suspend a session: capture, push, draft PRs |
| `/complete-work` | Lifecycle | Rebase, PR, merge, close the linked issue |
| `/sync-work` | Lifecycle | Push branches without ceremony |
| `/migrate-sessions` | Lifecycle | Drain the sessions a workspace still holds under the old session lifecycle |
| `/goal-driven-work` | Lifecycle | Run multi-phase work under `/goal` |
| `/promote` | Admin | Move personal knowledge into workspace context |
| `/context-placement` | Admin | Decide where durable content belongs, and what it costs |
| `/release` | Admin | Cut a versioned release of one project repo |
| `/maintenance` | Admin | Audit workspace health and clean up |
| `/setup-tracker` | Admin | Configure the issue tracker |
| `/workspace-init` | Admin | Initialize a workspace, or join one |
| `/workspace-update` | Admin | Apply a staged template update |
| `/build-docs-site` | Project | Build a Docusaurus documentation site |

## Capture Skills

These skills turn conversation knowledge into files that outlive it. Where a capture goes depends on where the chat is working. In a chat with no drawer, it is a gitignored `local-only-` draft, which becomes team-visible through `/promote`.

### /handoff

Saves workstream state: what was done, what is in progress, what comes next. Structured and actionable.

**Parameters:** `/handoff {name}` creates or updates a named handoff. With no name, the skill looks at the conversation and suggests one — and offers to split the capture if it finds several topics conflated.

**Where it writes:**

| Where you are | What it writes |
|---|---|
| Inside a legacy session's workspace worktree | The session tracker's `## Progress` section, at `work-sessions/{name}/workspace/session.md`, committed on the session branch |
| Anywhere else, in a chat with a drawer — the default | `handoff_{topic}.md` in the chat's drawer, `workspace-scratchpad/chats/{chat}/` — nothing is committed, because the drawer is gitignored |
| In a chat with no drawer, because the SessionStart hook injected no `Chat record:` line | A gitignored draft, `local-only-handoff_{topic}.md`, in `workspace-context/team-member/{user}/` — not committed |

**When to use it:** You are stopping work and someone, including future you, needs to know where things stand. You finished a chunk of work and want to record the state before moving on.

**What it produces:** An updated session tracker, a drawer file, or a local-only draft, as above.

### /braindump

Captures reasoning, exploration, and design rationale. More freeform than a handoff — designed for "why we chose X" content.

**Parameters:** `/braindump {name}` creates or updates a named braindump. With no name, the skill suggests one from the conversation.

**Where it writes:** Wherever `/handoff` does. In a legacy session it adds a section to the tracker's body, on the session branch. In a chat with a drawer it writes `braindump_{topic}.md` to the drawer. In a chat with no drawer it writes a gitignored `local-only-braindump_{topic}.md` to `workspace-context/team-member/{user}/`.

**When to use it:** The conversation produced a decision worth preserving. You discussed tradeoffs, explored alternatives, or settled on an approach. The signal is hearing "we decided..." — that means a decision just happened.

**What it produces:** Reasoning added to the session tracker, a drawer file, or a local-only draft, as above.

### /aside

Captures a drive-by idea without interrupting the current work. By default it dispatches a background agent to research and expand the idea while you continue working.

**Parameters:** `/aside <thought>` is the researched mode, the default. `/aside --quick <thought>` parks the thought as a note with no research step. There is no name parameter — the topic slug is generated from the thought.

**When to use it:** A thought crosses your mind that does not belong to the current work. An interesting pattern you noticed. A feature idea that should be explored later.

**What it produces:** A gitignored `local-only-` file in `workspace-context/team-member/{user}/` holding your original thought and, in researched mode, the agent's findings: `local-only-research_{topic}.md`, or `local-only-braindump_{topic}.md` with `--quick`. It is never committed, and it takes no part in a session, whether one is active or not. It stays local until `/promote` moves it.

## Lifecycle Skills

These skills carry a piece of work from start to finish. New work is always a **task**: one issue, one branch and one worktree per repo the work touches, with the chat staying at the workspace root. The **session** lifecycle — a self-contained `work-sessions/{name}/` folder with a tracker file — is legacy: no new session starts, and the sessions a workspace already has keep resuming and completing until `/migrate-sessions` drains them. Nothing in `workspace.json` selects between them. [Chapter 2](02-work-sessions.md) covers both.

### /start-work

Starts new work as a task, or resumes a session the workspace already has. Which flow it takes depends on the argument and on what is on disk.

**Parameters:**

- `/start-work` — start a task; a workspace that still has `work-sessions/` sessions is offered them first, so one can be resumed instead
- `/start-work blank` — start a task without offering the session list
- `/start-work handoff` — list shared context to resume from, then start the task it belongs to
- `/start-work all` — offer the workspace's sessions across all users when listing them
- `/start-work gh:42`, `#42` or an issue URL — start a task on that issue

**The task flow:** The skill identifies or creates the tracker issue and claims it: the one you named in the command, one you pick from a list — the issues assigned to you, falling back to unassigned ones — or a new one you describe, with its type, priority, an optional milestone and epic. If another chat already has a task for that issue, it offers to adopt the task or leave it with that chat. You pick the repos — the workspace repo itself can be one of them — and confirm a branch of `{prefix}/{slug}`. It creates one worktree per repo with `task-worktree.mjs` and records the task on the chat's record with `chat-record.mjs`. There is no session folder and no `session.md`: the issue, the branch and the chat record are the whole state. Without a tracker the task is still recorded, keyed by repo and branch.

**The resume flow:** You pick an existing session. The skill verifies the worktrees exist, registers the current chat in the session tracker's `chatSessions` frontmatter, and reconstructs any uncaptured history from previous conversations. Only sessions a workspace already has take this flow — nothing starts a new one.

### /pause-work

Suspends the active work session. Captures the current state to the session tracker, pushes all branches, creates draft pull requests, and marks the session as paused. If the session has a linked issue and a tracker is configured, it also posts the progress as a comment on that issue. The worktrees stay in place — the session is meant to be resumed.

**When to use it:** You are stopping for the day, switching to something else, or stepping away. You want your work backed up and visible but not finalized.

It belongs to the session lifecycle: with no active session, there is nothing to pause.

### /complete-work

Finalizes the work — rebase, PR, merge, and close the linked issue. It handles every project repo in the work and the workspace repo, under either lifecycle.

**The session flow**, in order:

1. Detects the context: which session, which repos, which lifecycle
2. Rebases each project repo against its default branch, and stops if conflicts arise
3. Offers a final `/braindump` to capture remaining discussion
4. Saves the current task list to the tracker
5. Gathers the source material: the session tracker, specs, plans, goal artifacts and research, handoffs, and the linked issue
6. Removes the session's specs and plans from the workspace branch, promoting first whatever deserves to survive into `workspace-context/`
7. Works out, per repo, whether its remote can host pull requests
8. Pushes all repos
9. Opens a pull request per repo, with a body built from the gathered material; presents a unified summary; and, on a "Merge all?", merges every PR together through the forge adapter. A repo with a local or bare remote is merged locally instead, with no PR
10. Closes the linked issue on the tracker
11. Cleans up the worktrees in the mandatory order and removes the session folder

**The task flow** starts with a pre-flight — every task worktree clean, and, when the chat's drawer holds a goal artifact, every `/goal` sub-branch already merged into the task branch. It then rebases each worktree onto its base and routes the durable thinking in the chat's drawer, asking what deserves to move into `workspace-context/`. The rest goes to `task-pr.mjs`: one PR per repo with a body written for it, the CI checks read for every PR, a merge that follows the task's merge-approval setting, the linked issue closed, and finally the worktrees torn down. [Chapter 2](02-work-sessions.md#the-task-model) has the detail.

**When to use it:** The work is done. You are ready to merge and move on.

### /sync-work

Pushes current branches to remote for all project repos and the workspace repo. No PRs, no lifecycle changes, no forced context capture. The lightest-touch backup — just pushes commits. If a repo has uncommitted changes, it offers to commit them first, with a message it suggests, and skips that repo if you decline.

**When to use it:** You want to back up your work without any ceremony. You are still actively working and just want a checkpoint.

It belongs to the session lifecycle: it reads the session tracker's list of repos.

**The three intents:**

| Skill | Intent | What happens |
|---|---|---|
| /pause-work | Stopping, someone might pick up | Capture + push + draft PR + mark paused |
| /complete-work | Done with this branch | Push + PR + merge + close the issue |
| /sync-work | Still working, just backing up | Push only |

### /migrate-sessions

Drains the work sessions a workspace still holds under the old session lifecycle. New work already starts as a task, so every entry under `work-sessions/` is work from before the task lifecycle, and this skill is how each one leaves it. It inventories the entries and proposes an outcome for each, with the evidence behind it. The decision is yours, one session at a time, and every session leaves one of three ways. **Finish** lands the session's work through the task lifecycle's own script: `task-pr.mjs` pushes the branch and opens one PR per repo from the session's worktrees (`--worktree` names them), merges them in order and closes the linked issue, after which the folder is archived. **Archive** moves the folder under `work-sessions/.archived/` with every commit and file, once its work is committed and backed up or the backup is declined on the record. **Remove** deletes an orphan shell that a second check finds holds nothing but empty directories. A session still being worked is left for a later run rather than finished or archived on a guess, and it stays on the drain list until then. The skill can also write `workspace.sessionModel: "task"` into `workspace.json` — a back-compat write that brings an older file in line with the template and routes nothing — on a branch, through a PR when the workspace repo has a forge remote or as a local fast-forward when it has none, asking before it merges.

It runs only inside the workspace it is run from, and the script deletes nothing but verified-empty orphan shells.

**When to use it:** The session-start hook says the workspace still has work sessions under the old session model, the maintenance audit lists them, or `/workspace-update` pointed you here. [Chapter 2](02-work-sessions.md#migrating-an-existing-workspace) has the detail.

### /goal-driven-work

Carries the procedure for multi-phase autonomous work under Claude Code's built-in `/goal` command. Use it when drafting a `goal-{topic}.md` artifact, defining phases, dispatching phase agent teams, or completing a goal-driven session. It covers the frontmatter schema, the three phase types, gate conventions, the integration-branch model with per-phase sub-PRs, and model tiering.

**When to use it:** The work is multi-phase, has an end state you can verify, and will span more than a turn or two. The `goal-driven-work` rule is the test for whether `/goal` is the right shape for the work; this skill covers everything after that decision.

**What it produces:** One `goal-{topic}.md` per effort, written in the lifecycle's work area, with the phase artifacts beside it. The default branch is untouched until `/complete-work` opens the final PR.

It runs inside started work: `/goal` does not replace `/start-work`.

## Admin Skills

These skills handle workspace context, configuration, maintenance, and releases.

### /promote

Moves personal auto-memory or `local-only-` files into workspace context. Use when you've discovered something valuable that the team should know.

It scans three sources — auto-memory, `local-only-*.md` files under `workspace-context/`, and `local-only-*.md` rules — and presents every candidate in one table, each with an assessment and a recommendation. You decide with codes: promote, drop, or keep. For each promotion you pick the destination — team-visible in `workspace-context/shared/`, personal in `workspace-context/team-member/{user}/`, or canonical in `workspace-context/shared/locked/` — and the skill rewrites the file for its new audience, removes the local-only original, and commits the result on its own. [Chapter 3](03-workspace-context.md#the-promotion-lifecycle) covers the flow.

### /context-placement

Decides where a durable fact, instruction, or procedure belongs: a rule, canonical context, shared or personal context, auto-memory, or a skill. Use it when something is worth keeping and you are not sure where it goes — and again when writing it, once the destination is settled.

It classifies the content, decides whether a rule has to apply always or only on matching paths, and states the always-loaded cost before anything is written, a step the skill does not treat as optional. It carries the frontmatter schema, the generator invocations, and the test for what qualifies as canonical.

### /release

Cuts a versioned release of one project repo: bumps the version, merges the bump through a PR, tags the merge commit, and publishes a forge release whose notes are generated from merged PRs. The workspace keeps no release-notes files of its own.

**Parameters:** `/release {version}` releases a specific version. `/release` shows the merged PRs since the last tag and asks for the version.

**The flow**, in order:

1. Determines the version and the repo — the one marked `primary`, by default
2. Preflights the tag and the forge
3. Bumps the version on a `release/v{version}` branch
4. Merges the bump, after a "Merge?" prompt
5. Runs the leak audit, when the workspace configures leak patterns, and reviews the consumer-facing prose — both before the tag, because the tag is the point of no return
6. Tags the merge commit and publishes the release. If the repo's own CI owns the release, the skill watches it rather than racing it
7. Tears down the release worktree and reports
8. Offers to update any release state the workspace keeps in `workspace-context/`

**When to use it:** A set of changes is ready to ship as a version. [Chapter 9](09-the-release-cycle.md) covers the release lifecycle.

### /maintenance

Audits workspace health and recommends cleanup. Run it periodically, or before `/release`.

**Parameters:** `/maintenance` runs both passes. `/maintenance audit` is the read-only pass. `/maintenance cleanup` acts on what the audit found.

**The audit is scripted.** `maintenance-audit.mjs` reports eight sections: cross-references, frontmatter, workspace structure, git state, the generated context catalogs, the always-loaded budget, template freshness, and team identity. It flags what is mechanically decidable — a broken reference, a context file still marked active a week after its last update, an over-budget total with its largest contributors, a catalog that is out of date. The worktree-level checks the script does not carry are run alongside it in the audit pass.

**The cleanup is judgment.** What to do about a flagged file, a stale piece of context, or two context files that contradict each other is not mechanically decidable. The cleanup pass walks through those with you and suggests merges where files overlap.

### /setup-tracker

Configures an issue tracker for the workspace, so that work items — bugs, features, chores — live in the tracker rather than in any local file. GitHub Issues and GitLab Issues are the shipped backends; another can be added by dropping an adapter at `.claude/scripts/trackers/{type}.mjs`. It can run during `/workspace-init` or on its own.

**What it produces:** A `workspace.tracker` block in `workspace.json` — `type` and `repo`, with `host` for a self-managed GitLab — committed on the current branch. On the tracker itself: the labels `bug`, `feat`, `chore`, `P1`, `P2` and `P3`, and optionally milestones and epics. In label mode, the default, an epic is a label `epic:{name}`; GitLab Premium groups can use native group epics instead.

**When to use it:** The workspace has no tracker yet. `/start-work` offers it when you start work without one.

### /workspace-init

First-time workspace initialization, or joining a workspace a teammate already initialized. Run it once after scaffolding with `--init`.

**The init flow** sets up the workspace itself. It clones the repos in the manifest and registers each as a `repo-{name}` remote of the workspace repo, installs the remaining template components from the staged payload, activates the optional rules you choose, and configures your identity. It reports the work lifecycle as task — new work is always a task, so there is nothing to choose. It then extracts team knowledge — from the documentation sources you point it at, and from prior Claude chat history — into `workspace-context/`, formalizes any in-progress git worktrees as work sessions, and offers to set up an issue tracker and to generate `CODEBASE.md`. Finally it cleans up the payload, checks the result for self-contradictions, sets up the workspace's own remote, `origin`, and marks the workspace initialized. It works on a `chore/workspace-init` branch, and ends by offering to squash-merge that branch into the default branch, pushing it if the workspace repo has an `origin`.

**The join flow** runs when the workspace is already initialized — a teammate who has just cloned it. It sets up only that one machine: the user identity, the missing repo clones (each registered as a `repo-{name}` remote of the workspace repo), the per-user context folder, and `CLAUDE.local.md`. It never touches tracked files, creates no branch, and makes no commits.

**When to use it:** Right after scaffolding, and once per machine for everyone who joins later. [Chapter 10](10-installation-and-upgrades.md) walks through both.

### /workspace-update

Applies a staged template update to an initialized workspace. The CLI's `--upgrade` stages the new payload in `.workspace-update/`; this skill processes it and verifies the result with a scripted audit.

**The flow**, in order:

1. Decides where the update lands: in a task worktree and through a PR when the workspace repo has a remote of its own (`origin`), in place when it has none
2. Classifies every file in the payload — new, updated, locally modified, activated, removed, and the rest
3. Applies the changes with your confirmation, merging files you have customized three-way against the template you are upgrading from, and asking about anything it cannot merge. In CLAUDE.md, a line the template has retired — an include it no longer ships, or a bullet that is no longer true — is dropped and named in the diff you approve
4. Advances `templateVersion`, writes the template baseline, and runs the migrators
5. Verifies: rebuilds the context catalogs and runs the maintenance audit once, marking findings on the files this update touched
6. Cleans up and commits. When the sessions directory still holds sessions under the old session lifecycle — counted from the directory alone, whatever `workspace.sessionModel` says — its report points you at `/migrate-sessions`

See [Chapter 10](10-installation-and-upgrades.md) for the upgrade flow.

## Project Skills

These skills produce something for a project repository.

### /build-docs-site

Builds a comprehensive Docusaurus documentation site for a project. It consolidates scattered knowledge sources — the README, `docs/`, any existing site, the code, shared context, chat dumps and exports — into a coherent, branded reference with theme-aware diagrams. It replaces the existing documentation, using it as raw material.

**Parameters:** `/build-docs-site` starts a new site, or resumes an in-progress one. `/build-docs-site --diagrams` resumes at the diagram phase on an existing site.

**When to use it:** A project's documentation has outgrown a README. It is a multi-hour skill that needs work to have been started — run `/start-work` first if it has not — and a confirmed target repo.

**What it produces:** A Docusaurus site at `docs-site/` (or `apps/docs-site/` in a monorepo), a `sources.md` inventory and a `design-docs-site.md` spec at the project worktree's root, and a final report naming the files it replaced and any URLs that may need redirects. It opens no PR of its own: `/complete-work` handles the merge.

## How Skills Chain Together

Skills are independent, but they form a natural workflow:

```
/workspace-init (once per workspace)
    ↓
  /start-work — offers /setup-tracker if no tracker is configured
    ↓
  work, commit, iterate — /goal with /goal-driven-work for multi-phase work
    ↓
  /braindump or /handoff (as decisions happen) — /aside for drive-by ideas
    ↓
  /complete-work (when done) — /promote runs inside it for what deserves to survive
    ↓
  /release (when cutting a version)
    ↓
  /maintenance (periodically)
```

A legacy session adds two steps of its own to the middle of that: `/sync-work` for backup checkpoints, and `/pause-work` when stopping, with `/start-work` resuming it later.

The chaining is a natural workflow, not enforced coupling: any skill can be invoked on its own. Four have a precondition worth knowing. `/complete-work` needs work to complete — a task recorded on the chat, or an active session. `/workspace-update` needs an initialized workspace, and says so if `/workspace-init` has not run. `/build-docs-site` needs work to have been started. `/workspace-init` needs the payload the CLI stages at scaffold time.

---

## Key Takeaways

- Skills are on-demand workflow commands. Only a skill's description is always loaded; its body is read when it is invoked.
- The template ships seventeen skills: three capture, six lifecycle, seven admin, and one project.
- Capture skills (/handoff, /braindump, /aside) turn conversation knowledge into files. The first two write to a legacy session's tracker, otherwise to the chat's drawer, and — in a chat with no drawer — a local-only draft; /aside always writes a local-only draft.
- Lifecycle skills (/start-work, /pause-work, /complete-work, /sync-work, /migrate-sessions, /goal-driven-work) carry work from start to finish. /start-work and /complete-work serve both lifecycles; /pause-work and /sync-work belong to the session lifecycle.
- Admin skills (/promote, /context-placement, /release, /maintenance, /setup-tracker, /workspace-init, /workspace-update) manage workspace context, configuration, maintenance and releases.
- /build-docs-site builds a documentation site for a project repo.
- Skills chain into a natural workflow, but each can run on its own once its precondition is met.
