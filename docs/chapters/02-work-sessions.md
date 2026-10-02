# Work Sessions

A work session is the unit of tracked work in a workspace. It represents a coherent piece of effort — a feature, a bugfix, a refactor — that spans one or more Claude Code conversations and produces a branch, a set of changes, and a pull request. Sessions give structure to work without requiring ceremony to start.

This chapter explains how sessions work, what they create, and how they enable parallel and multi-repo workflows. A second, lighter lifecycle — the task model — is described in [the last section](#the-task-model); the session model below remains the default.

---

## What a Session Is

A work session is a named entity that binds together a branch, one or more worktrees, and a context tracker. You start one with `/start-work`, do your work across as many conversations as needed, and finish with `/complete-work`. Between conversations, the session persists — its state is recorded in a single session tracker file, and the self-contained session folder on disk is ready to resume.

Sessions are not chat sessions. A chat session is a single Claude Code conversation — it starts when you open a terminal and ends when you close it. A work session spans multiple chat sessions. You might start a feature in the morning, pause for lunch, resume in the afternoon, and complete it the next day. That is one work session across three or four chat sessions.

This distinction matters because context works differently at each boundary. When a chat session ends, Claude's conversation memory is gone. When a work session persists, the session tracker preserves the state so the next chat can pick up where the last one left off.

## The Session Lifecycle

Every session follows the same arc:

**Start** — `/start-work` creates the session. You describe what you're working on, pick which repos to include, and confirm the branch name. The system creates a `work-sessions/{name}/` folder containing a workspace worktree with nested project worktrees and an initialized session tracker.

**Work** — You make changes in the worktrees. As you go, you can capture context with `/braindump` or `/handoff`, and back up your work with `/sync-work`. The session tracker's body accumulates progress across conversations.

**Pause (optional)** — `/pause-work` suspends the session. It captures the current state, pushes all branches, and creates draft pull requests. The session folder stays in place — worktrees stay, the tracker stays, and you can resume later.

**Complete** — `/complete-work` finalizes everything. It rebases your branches, builds the PR bodies from the session's accumulated context, pushes all repos, creates pull requests, and presents a unified merge prompt. After merging, it tears down the worktrees in the correct order and removes the entire session folder.

```
/start-work → work → /sync-work (backup) → work → /complete-work
                  ↘ /pause-work (suspend) ... /start-work (resume) ↗
```

The lifecycle skills are covered in detail in [Chapter 6](06-skills.md). This chapter focuses on the mechanics underneath.

## The Session Folder

Each session lives in its own folder at `work-sessions/{session-name}/`. That folder is self-contained: everything the session needs is inside it.

```
work-sessions/fix-auth/
└── workspace/                         # Workspace worktree (on session branch)
    ├── .claude/                       # Settings, active-session pointer
    ├── CLAUDE.md                      # Inherited from the workspace branch
    ├── session.md                     # Session tracker — on the session branch
    ├── design-auth-redesign.md        # Spec — on the session branch
    ├── plan-auth-redesign.md          # Plan — on the session branch
    ├── shared-context/                # Workspace shared-context, on this branch
    └── repos/                         # Real directory (not symlink)
        ├── my-app/                    # Project worktree on bugfix/fix-auth
        └── my-api/                    # Project worktree on bugfix/fix-auth
```

Session content — tracker, specs, plans — lives at the top of the workspace worktree and is tracked on the session branch. Pushing the branch carries the durable session thinking across machines. `/complete-work` offers to promote whatever deserves to survive into `workspace-context/`, then removes the files from the branch before the final PR so main's top level stays free of session-scoped files.

The `work-sessions/` folder itself is fully gitignored at the workspace root — nothing at the launcher level is tracked. The tracking happens inside each session's worktree, on the session branch, where it naturally belongs.

The workspace worktree is where Claude runs when working on this session. It contains a real `repos/` directory (not a symlink), with each project worktree nested inside it. From inside the workspace worktree, all project worktrees are accessible at `repos/{repo-name}/` — the same path convention skills use everywhere else.

The workspace `.gitignore` has a single `repos` line (no trailing slash) that covers both the workspace root's source-clone directory and every workspace worktree's nested `repos/`. One line, both uses.

## The Session Tracker

The session tracker is `work-sessions/{name}/workspace/session.md`. It is a single markdown file with two halves: YAML frontmatter holds the machine state, and the body holds human content.

```markdown
---
type: session-tracker
name: fix-auth
description: Fix authentication timeout on mobile
status: active
branch: bugfix/fix-auth
created: 2026-04-13T10:00:00.000Z
user: alice
repos:
  - my-app
  - my-api
workItem: gh:42
chatSessions:
  - id: aa3c952e-dbff-4055-8bcc-e5f217618d57
    names: []
    started: 2026-04-13T10:00:00.000Z
    ended: null
author: alice
updated: 2026-04-13
---

# Work Session: fix-auth

## Progress

Decisions made, work completed, blockers hit. Updated across chats.
```

Machine state lives in the frontmatter: the current status (`active`, `paused`), the branch, the list of repos, the `workItem` linkage to a configured tracker (an adapter-prefixed ID like `gh:42` for GitHub Issues), and the chat sessions that have contributed to this work session. Hooks and scripts read and update these fields via a small parser at `.claude/lib/session-frontmatter.mjs` that rewrites only the fields that changed, leaving every other byte of the file untouched.

Human content lives in the body: decisions, progress, next steps, captured reasoning from `/handoff` and `/braindump`. This is what `/complete-work` draws on for the PR body at the end of the session.

Because the tracker is a single tracked file, the session's durable thinking travels with the workspace branch. Push on one machine, pull on another, and the tracker (and any specs or plans) is already there. Worktrees are local — they get recreated the first time you resume the session on each machine.

## Worktrees

When a session starts, the workspace creates worktrees — lightweight git checkouts that exist alongside the original repo clones. Each session gets one workspace worktree plus one worktree per project repo, and all of them are nested inside the session folder:

```
repos/                              # Source clones at workspace root
├── my-app/                         # Stays on main, untouched
└── my-api/                         # Stays on main, untouched

work-sessions/fix-auth/workspace/   # Workspace worktree
└── repos/                          # Real directory inside the worktree
    ├── my-app/                     # Project worktree on bugfix/fix-auth
    └── my-api/                     # Project worktree on bugfix/fix-auth
```

The source clones at the workspace root are never disturbed — they stay on their default branch. Worktrees are created from them and live inside the session folder. This lets you run multiple sessions in parallel without any branch-switching conflicts.

Multi-repo sessions work because all repos in a session share the same branch name. If `fix-auth` is on `bugfix/fix-auth`, every repo in the session has a `bugfix/fix-auth` branch and a worktree on it. The same name across repos makes the relationship traceable — you can find all the pieces of a multi-repo change by searching for the branch name.

### Teardown order matters

When a session completes, tearing down the worktrees has to happen in a specific order. The cleanup script enforces it automatically:

1. Remove each nested **project** worktree from its project repo (`git -C repos/{repo} worktree remove ...`)
2. Remove the **workspace** worktree from the workspace repo
3. Run `git worktree prune` on each project repo as a safety net
4. Delete the local branches
5. `rm -rf work-sessions/{name}/`

If you remove the workspace worktree first, git happily deletes the directory tree including the nested project worktrees' `.git` files — but it leaves orphan worktree records in the project repos marked `prunable`. The operation looks successful but the project repos are now inconsistent. The safe order keeps both sides in sync.

## Multi-Repo Sessions

A work session can span multiple project repositories. When you start a session, you can select one or more repos from the workspace manifest. All selected repos get the same branch name, so the session is traceable as one unit of work even though it touches multiple repos.

This is essential for changes that cross repository boundaries. A UI change in the frontend repo that requires an API change in the backend repo belongs in one session, not two.

If you start a session with one repo and realize mid-session that you need another, you can add it. The `/start-work` skill detects the active session and offers to add a repo. The repo-write-detection hook also watches for this — if you try to write to a repo that is in the workspace but not in the current session, Claude is nudged to offer adding it before proceeding.

At completion, multi-repo sessions merge atomically. `/complete-work` creates a pull request for each project repo plus one for the workspace, presents them as a unified summary, and prompts "Merge all?" All PRs merge together or none do.

## Parallel Sessions

Because each session lives in its own self-contained folder with its own worktrees, you can run multiple sessions at the same time. Open a terminal, resume or start a session, and work. Open another terminal, start a different session. They do not interfere with each other.

```
Terminal 1:                                  Terminal 2:
work-sessions/fix-auth/workspace/            work-sessions/add-search/workspace/
  Session: fix-auth                            Session: add-search
  Branch: bugfix/fix-auth                      Branch: feature/add-search
  Repos: my-app, my-api                        Repos: my-app
```

Both sessions can touch the same repo (in this example, both include `my-app`) because each has its own worktree. Git worktrees share the object store but have independent working directories and indexes.

When you run `/start-work` with no arguments, it walks `work-sessions/` and lists all active or paused sessions so you can choose which one to resume:

```
Active work sessions:
  1. fix-auth (active, last chat ended 2h ago)
     "Fix authentication timeout on mobile"
     Branch: bugfix/fix-auth | Repos: my-app, my-api

  2. add-search (paused, last chat ended 1d ago)
     "Add full-text search to listings"
     Branch: feature/add-search | Repos: my-app

  [N] Start something new

Which one?
```

## Resuming Across Conversations

When you resume a session in a new conversation, the system reconstructs context. The session tracker's frontmatter tells Claude what the session is about, which repos are involved, and what branch to work on. The tracker's body provides accumulated progress notes from previous conversations.

The history reconstruction mechanism goes further: it checks whether the previous conversation's work was captured in the tracker body. If there is a gap — work happened but was not captured — it scans the conversation history and generates a summary to fill the gap. This means you do not lose context between conversations even if you forget to `/handoff` or `/braindump` at the end.

The practical result is that each new conversation starts with awareness of everything the session has done so far, even if it happened days ago in a different conversation or on a different machine.

## The Task Model

The session model above is the default and remains fully supported. A second, lighter lifecycle — the **task model** — covers the most common shape of work: one issue, one branch, done in a chat. Set `"sessionModel": "task"` under `workspace` in `workspace.json` to route new work to it. Existing `work-sessions/` sessions keep resuming under the session model regardless of the setting.

A task is a tracker issue plus a branch plus one worktree per repo the work touches:

- Project repos: `repos/{repo}/.claude/worktrees/{slug}/`, where `{slug}` is the branch with `/` replaced by `-`
- The workspace repo itself, addressed as `.`: `.claude/worktrees/{slug}/` — the same location Claude Code's native worktree feature uses, so the two converge

There is no session folder and no `session.md`. The chat stays at the workspace root (the launcher, which never leaves its default branch) and reaches the worktrees by path. Per-chat state is machine-local: the **chat record** at `workspace-scratchpad/chats/{chat}.json` lists the chat's open tasks, and the **chat drawer** at `workspace-scratchpad/chats/{chat}/` holds in-progress designs, plans, goal artifacts, braindumps and research until completion routes them. The SessionStart hook injects a `Chat record:` line naming the record and a `Workspace root:` line anchoring the launcher, so skills never guess either.

`/start-work` under the task model: pick or create the tracker issue (or skip tracking entirely), pick the repo(s) — the workspace repo can be one of them — propose the branch, create one worktree per repo with `.claude/scripts/task-worktree.mjs`, and record the task on the chat record. The record, the issue, and the branch are the entire state.

`/complete-work` under the task model: rebases each worktree onto its default branch, offers to promote drawer items into `workspace-context/` (through a workspace-repo worktree on the task's branch, so nothing lands on the launcher's default branch), writes a short PR body per repo into the drawer, then hands the rest to `.claude/scripts/task-pr.mjs` — one command pushes and opens one PR per repo (the workspace repo included), recording local-mode repos for a local merge instead, a second merges them in order and closes the issue — and finally tears the worktrees down and clears the record entries.

### Local mode

A repo whose origin is not a forge — no origin remote at all, or `merge: "local"` under `repos.{repo}` in `workspace.json` (`workspace.merge` for the workspace repo `.`) — completes the task in **local mode**: nothing is pushed and no PR is opened for it. The override exists for a clone whose origin is a third-party upstream nobody here may push to; an origin that is neither forge-hosted nor overridden stops completion with the setting spelled out. Merging a local repo fast-forwards its default branch in the repo's own source clone (`repos/{repo}`, or the launcher for `.`), which must be sitting clean on that branch; a branch that will not fast-forward stops the run and asks for a rebase first. The ordering is unchanged — project repos first, the workspace repo last — and mixed forge/local tasks complete in one run. A workspace with no tracker works the same way: the task is recorded keyed by repo + branch, and completion simply has no issue to close.

Several tasks can be open at once across chats; each is just a branch plus its worktrees. The session model remains the right choice for long multi-chat efforts that want a folder, a tracker file, and pause/resume semantics — and both lifecycles can coexist in one workspace while a team migrates.

Lane chats — one long-lived chat per workstream, hopping between pieces of work over days — sit at the launcher across both lifecycles. Detection meets them there: `task-worktree.mjs --detect --chat` also matches the chat's session id (`--session-id`, the chat record's `sessionId`, or `$CLAUDE_CODE_SESSION_ID`) against each session's `chatSessions` frontmatter, so `/complete-work` can finish an old `work-sessions/` session from the launcher chat that drove it — and when the chat has both open tasks and matching sessions, detection reports `mixed` and the operator picks which to finish. `/start-work gh:N` on an issue that already has a task finds the owning chat with `chat-record.mjs --owner gh:N`, reuses the existing worktrees (`--create` never duplicates), and either adopts the task into this chat or messages the owner by name. What a handoff leaves behind goes on the issue as a comment, not in the drawer — the drawer is per-chat and machine-local, and no other chat can read it.

## Migrating an Existing Workspace

A workspace that grew up on sessions can move to the task model in place with `/migrate-sessions`. It inventories `work-sessions/` and proposes one of six outcomes per session — **MERGEABLE** (real content survives: files on the branch, commits ahead in a project repo, or uncommitted work), **ABANDONED** (stale, artifact-only), **ACTIVE** (worked on recently), **UNKNOWN** (no activity signal at all — never assumed abandoned), **REMOVE_SHELL** (a broken folder with no worktree left), or **LEAVE** (a symlinked "foreign" entry that is never followed) — with the evidence behind each: recency, content beyond session artifacts, commits ahead, per-remote divergence, and whether anything exists on a remote. Proposals are only proposals: the operator decides each session, one at a time. Mergeable sessions finish through the normal `/start-work` → `/complete-work` flow; kept sessions simply keep working under the session lifecycle; the rest are **archived** — the session folder moves to `work-sessions/.archived/`, git's worktree links follow it, and every commit and file comes along. The migration never deletes anything: an optional backup tags each session's branches as `drain/{session}/…` locally, and pushes those tags only to remotes the operator explicitly allows — never to a third-party upstream or a read-only mirror. Deleting an archive later is a separate, manual decision. When the list is drained, the skill flips `workspace.sessionModel` to `"task"` on a branch — merged through a PR when the workspace repo has a forge remote, or fast-forwarded locally when it has none — never as a direct edit on the launcher's tracked `workspace.json`.

The rule that holds it together: a migration only ever touches the workspace it runs in. Never point it at another workspace, and never batch several workspaces through one run — each workspace drains its own sessions from its own root.

---

## Key Takeaways

- A work session is the unit of tracked work — one branch, one self-contained folder, one lifecycle.
- Each session lives at `work-sessions/{name}/` with its own workspace worktree and nested project worktrees.
- The session tracker (`session.md`) is one markdown file with machine state in frontmatter and human content in the body — tracked in git so it travels across machines.
- Multi-repo sessions use the same branch name across all repos for traceability.
- Parallel sessions run in separate terminals, each in their own folder, without conflict.
- Teardown order is mandatory: project worktrees first, then the workspace worktree, then the session folder.
