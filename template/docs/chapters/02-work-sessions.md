# Work Sessions

A work session is the unit of tracked work in a workspace. It represents a coherent piece of effort — a feature, a bugfix, a refactor — that spans one or more Claude Code conversations and produces a branch, a set of changes, and a pull request. Sessions give structure to work without requiring ceremony to start.

This chapter explains how sessions work, what they create, and how they enable parallel and multi-repo workflows.

---

## What a Session Is

A work session is a named entity that binds together a branch, one or more worktrees, and a context tracker. You start one with `/start-work`, do your work across as many conversations as needed, and finish with `/complete-work`. Between conversations, the session persists — its state is recorded in a marker file, and its context is accumulated in an inflight tracker.

Sessions are not chat sessions. A chat session is a single Claude Code conversation — it starts when you open a terminal and ends when you close it. A work session spans multiple chat sessions. You might start a feature in the morning, pause for lunch, resume in the afternoon, and complete it the next day. That is one work session across three or four chat sessions.

This distinction matters because context works differently at each boundary. When a chat session ends, Claude's conversation memory is gone. When a work session persists, the session marker and inflight tracker preserve the state so the next chat can pick up where the last one left off.

## The Session Lifecycle

Every session follows the same arc:

**Start** — `/start-work` creates the session. You describe what you're working on, pick which repos to include, and confirm the branch name. The system creates worktrees, writes a session marker, and initializes an inflight tracker.

**Work** — You make changes in the worktrees. As you go, you can capture context with `/braindump` or `/handoff`, and back up your work with `/sync-work`. The inflight tracker accumulates progress across conversations.

**Pause (optional)** — `/pause-work` suspends the session. It captures the current state, pushes all branches, and creates draft pull requests. The session remains in place — worktrees stay, the marker stays, and you can resume later.

**Complete** — `/complete-work` finalizes everything. It rebases your branches, synthesizes release notes from the session's accumulated context, pushes all repos, creates pull requests, and presents a unified merge prompt. After merging, it cleans up the worktrees and session marker.

```
/start-work → work → /sync-work (backup) → work → /complete-work
                  ↘ /pause-work (suspend) ... /start-work (resume) ↗
```

The lifecycle skills are covered in detail in [Chapter 6](06-skills.md). This chapter focuses on the mechanics underneath.

## Session Markers

The session marker is the source of truth for a session's state. It is a JSON file stored in `.claude-scratchpad/`:

```json
// .claude-scratchpad/.work-session-fix-auth.json
{
  "name": "fix-auth",
  "description": "Fix authentication timeout on mobile",
  "branch": "bugfix/fix-auth",
  "repos": ["my-app", "my-api"],
  "status": "active",
  "created": "2026-04-05T10:00:00Z",
  "user": "myron",
  "chatSessions": []
}
```

The marker records the session name, which repos are involved, the branch name, and the current status (`active` or `paused`). It also tracks which chat sessions have contributed to this work session, enabling history reconstruction when you resume.

Because the scratchpad is gitignored, session markers are local to your machine. If you lose them (clear the scratchpad, switch workstations), the session can be reconstructed from git state — the branch names and worktrees are the durable artifacts.

## Worktrees

When a session starts, the workspace creates worktrees — lightweight git checkouts that exist alongside the original repo clone. Each session gets one workspace worktree plus one worktree per project repo:

```
repos/
├── my-app/                        # Original clone (stays on main)
├── my-api/                        # Original clone (stays on main)
├── fix-auth___wt-workspace/       # Workspace worktree for this session
├── fix-auth___wt-my-app/          # my-app worktree on bugfix/fix-auth
└── fix-auth___wt-my-api/          # my-api worktree on bugfix/fix-auth
```

The naming convention is `{session-name}___wt-{type}`, where type is either `workspace` or the repo name. The triple-underscore separator (`___`) makes it easy to parse and unlikely to collide with real repo names.

Worktrees solve a fundamental problem: git branches require switching, and switching disrupts other work. With worktrees, each session has its own checkout. The original clone stays on its default branch, undisturbed. You can open one terminal in `fix-auth___wt-my-app/` and another terminal in `add-search___wt-my-app/` and work on both simultaneously.

The workspace worktree (`fix-auth___wt-workspace/`) is where Claude runs when working on this session. It contains a `repos/` symlink that points back to the repos directory, so all project worktrees are accessible. It also has its own `.claude-scratchpad/` with an active-session pointer that tells hooks and skills which session is in context.

## Multi-Repo Sessions

A work session can span multiple project repositories. When you start a session, you can select one or more repos from the workspace manifest. All selected repos get the same branch name — if the session is `fix-auth` on branch `bugfix/fix-auth`, every repo gets a `bugfix/fix-auth` branch and worktree.

This is essential for changes that cross repository boundaries. A UI change in the frontend repo that requires an API change in the backend repo belongs in one session, not two. The same branch name across repos makes the relationship traceable — you can find all the pieces of a multi-repo change by searching for the branch name.

If you start a session with one repo and realize mid-session that you need another, you can add it. The `/start-work` skill detects the active session and offers to add a repo. The repo-write-detection hook also watches for this — if you try to write to a repo that is in the workspace but not in the current session, Claude is nudged to offer adding it before proceeding.

At completion, multi-repo sessions merge atomically. `/complete-work` creates a pull request for each project repo plus one for the workspace, presents them as a unified summary, and prompts "Merge all?" All PRs merge together or none do.

## Parallel Sessions

Because each session lives in its own worktrees, you can run multiple sessions at the same time. Open a terminal, resume or start a session, and work. Open another terminal, start a different session. They do not interfere with each other.

```
Terminal 1:                          Terminal 2:
repos/fix-auth___wt-workspace/       repos/add-search___wt-workspace/
  Session: fix-auth                    Session: add-search
  Branch: bugfix/fix-auth              Branch: feature/add-search
  Repos: my-app, my-api               Repos: my-app
```

Both sessions can touch the same repo (in this example, both include `my-app`) because each has its own worktree. Git worktrees share the object store but have independent working directories and indexes.

When you run `/start-work` with no arguments, it lists all active sessions so you can choose which one to resume:

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

When you resume a session in a new conversation, the system reconstructs context. The session marker tells Claude what the session is about, which repos are involved, and what branch to work on. The inflight tracker provides accumulated progress notes from previous conversations.

The history reconstruction mechanism goes further: it checks whether the previous conversation's work was captured in the inflight tracker. If there is a gap — work happened but was not captured — it scans the conversation history and generates a summary to fill the gap. This means you do not lose context between conversations even if you forget to `/handoff` or `/braindump` at the end.

The practical result is that each new conversation starts with awareness of everything the session has done so far, even if it happened days ago in a different conversation.

---

## Key Takeaways

- A work session is the unit of tracked work — one branch, one or more worktrees, one lifecycle.
- Sessions persist across multiple Claude Code conversations via markers and inflight trackers.
- Worktrees isolate each session's work — the original repo clones are never disturbed.
- Multi-repo sessions use the same branch name across all repos for traceability.
- Parallel sessions run in separate terminals, each with their own worktrees, without conflict.
