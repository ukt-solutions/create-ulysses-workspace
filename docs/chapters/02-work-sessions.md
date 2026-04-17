# Work Sessions

A work session is the unit of tracked work in a workspace. It represents a coherent piece of effort — a feature, a bugfix, a refactor — that spans one or more Claude Code conversations and produces a branch, a set of changes, and a pull request. Sessions give structure to work without requiring ceremony to start.

This chapter explains how sessions work, what they create, and how they enable parallel and multi-repo workflows.

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

**Complete** — `/complete-work` finalizes everything. It rebases your branches, synthesizes release notes from the session's accumulated context, pushes all repos, creates pull requests, and presents a unified merge prompt. After merging, it tears down the worktrees in the correct order and removes the entire session folder.

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

Session content — tracker, specs, plans — lives at the top of the workspace worktree and is tracked on the session branch. Pushing the branch carries the durable session thinking across machines. `/complete-work` reads the content into release notes, then removes the files from the branch before the final PR so main's top level stays free of session-scoped files.

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
workItem: 3
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

Machine state lives in the frontmatter: the current status (`active`, `paused`), the branch, the list of repos, the `workItem` link back to `open-work.md`, the chat sessions that have contributed to this work session. Hooks and scripts read and update these fields via a small parser at `.claude/lib/session-frontmatter.mjs` that rewrites only the fields that changed, leaving every other byte of the file untouched.

Human content lives in the body: decisions, progress, next steps, captured reasoning from `/handoff` and `/braindump`. This is what `/complete-work` synthesizes into release notes at the end of the session.

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

---

## Key Takeaways

- A work session is the unit of tracked work — one branch, one self-contained folder, one lifecycle.
- Each session lives at `work-sessions/{name}/` with its own workspace worktree and nested project worktrees.
- The session tracker (`session.md`) is one markdown file with machine state in frontmatter and human content in the body — tracked in git so it travels across machines.
- Multi-repo sessions use the same branch name across all repos for traceability.
- Parallel sessions run in separate terminals, each in their own folder, without conflict.
- Teardown order is mandatory: project worktrees first, then the workspace worktree, then the session folder.
