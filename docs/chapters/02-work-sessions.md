# Tasks

Work in a workspace has one lifecycle: the **task**. A task is one tracker issue, one branch, one worktree per repo the work touches, and a chat that stays at the workspace root. There is no folder to create and no tracker file to keep. The issue, the branch and the chat's record are the entire state.

This chapter explains what a task is, where it lives on disk, how several run at once, how one stays a single unit of work across repositories, and what became of the sessions earlier versions had.

---

## What a Task Is

A task binds an issue to a branch, and the branch to one worktree per repository it touches. It is started with `/start-work`, worked on for as long as it takes, and finished with `/complete-work`.

A task is not a chat session. A chat session is a single Claude Code conversation — it starts when you open a terminal and ends when you close it. A task can span several. You might start a fix in the morning, hand it off at lunch, and complete it the next day from another chat. That is one task across three or four chat sessions.

The distinction matters because context works differently at each boundary. When a chat session ends, Claude's conversation memory is gone. A task carries nothing in memory across that line. What it keeps is on disk — the branch with its commits, the issue with its discussion, and the chat's record and drawer — and the next chat reads it from there.

## The Task Lifecycle

Every task follows the same arc:

**Start** — `/start-work` identifies or creates the tracker issue and claims it. You pick the repos — the workspace repo itself can be one of them — and confirm a branch of `{prefix}/{slug}`. The skill creates one worktree per repo and records the task on the chat's record.

**Work** — You make changes in the worktrees. As you go, capture context with `/braindump` or `/handoff`. Both write to the chat's drawer.

**Complete** — `/complete-work` finalizes the task. It rebases each worktree onto its default branch, asks which of the chat's notes deserve to move into `workspace-context/`, builds a PR body per repo, and presents one summary with a single merge approval. After the merge it closes the linked issue and tears down the worktrees and the record entries.

```
/start-work → work → /complete-work
                  ↘ /handoff → pick the task up again from the same issue ↗
```

The lifecycle skills are covered in detail in [Chapter 6](06-skills.md). This chapter focuses on the mechanics underneath.

## Where a Task Lives

A task has no folder of its own. Its worktrees sit inside the repositories they belong to, and its state sits in the scratchpad beside the chat that owns it:

```
my-workspace/
├── repos/                              # Source clones — gitignored
│   ├── my-app/                         # Stays on main, untouched
│   │   └── .claude/worktrees/
│   │       └── bugfix-fix-auth/        # Task worktree for my-app
│   └── my-api/                         # Stays on main, untouched
│       └── .claude/worktrees/
│           └── bugfix-fix-auth/        # Task worktree for my-api
├── .claude/worktrees/
│   └── bugfix-fix-auth/                # When the task touches the workspace repo itself
└── workspace-scratchpad/               # Machine-local — gitignored
    └── chats/
        ├── fix-login.json              # The chat's record: the tasks it has open
        └── fix-login/                  # The chat's drawer: work in progress
```

A worktree is named after its branch with `/` replaced by `-`, so `bugfix/fix-auth` lives at `repos/my-app/.claude/worktrees/bugfix-fix-auth/`. That is the same location Claude Code's own worktree feature uses, so a task started here and one started natively converge on a single layout.

The workspace repo itself is addressed as `.`. Its worktree lives at `.claude/worktrees/{slug}/`, one level up — again where Claude Code puts worktrees of the repository it was launched in. The workspace `.gitignore` covers all of it: `repos` for the source clones and every worktree inside them, and `.claude/worktrees/` for the workspace repo's own.

## The Chat Record and the Drawer

Each chat has a record at `workspace-scratchpad/chats/{chat}.json`, and a drawer beside it at `workspace-scratchpad/chats/{chat}/`. The record is the task's bookkeeping. The drawer is where its thinking accumulates.

The record lists the chat's open tasks. A task that touches two repositories is two entries sharing a branch:

```json
{
  "chat": "fix-login",
  "sessionId": "aa3c952e-dbff-4055-8bcc-e5f217618d57",
  "scope": { "epic": null, "labels": [], "paths": [] },
  "concerns": [],
  "tasks": [
    { "workItem": "gh:42", "branch": "bugfix/fix-auth", "repo": "my-app" },
    { "workItem": "gh:42", "branch": "bugfix/fix-auth", "repo": "my-api" }
  ]
}
```

`workItem` is the adapter-prefixed issue ID — `gh:42` for GitHub Issues — or `null` for a task started without a tracker. The prefix makes it self-describing across adapter swaps. The tracker itself remains authoritative for status, assignment, labels and milestone; the record holds only the pointer.

The drawer holds what is not ready for the team: designs, plans, goal artifacts, braindumps and research, written by `/braindump`, `/handoff` and the skills that draft specs. Nothing there is committed, because the drawer is gitignored. At completion, `/complete-work` lists the drawer and asks what deserves to move into `workspace-context/`.

Both are machine-local. The SessionStart hook injects two lines into every chat, so skills never have to guess either: `Chat record: {chat}` names the record, and `Workspace root: {path}` anchors the launcher. And because a drawer belongs to one chat on one machine, nothing in it reaches another chat by itself. Whatever the next chat needs in order to continue a task — or a teammate on another machine — goes on the issue as a comment.

## Worktrees

A task's worktrees are lightweight git checkouts that exist alongside the original repo clones. The clones themselves are never disturbed: they stay on their default branch, and worktrees are created from them. This lets you run several tasks in parallel without any branch-switching conflicts, and it keeps the launcher — which never leaves its default branch — always ready to start the next one.

## Multi-Repo Tasks

A task can span several project repositories. All of them get the same branch name, so the task is traceable as one unit of work even though it touches several repos. You can find every piece of a multi-repo change by searching for the branch name.

This is essential for changes that cross repository boundaries. A UI change in the frontend repo that requires an API change in the backend repo belongs in one unit of work, not two.

At completion, a multi-repo task lands as one. `/complete-work` creates a pull request for each project repo — and one for the workspace repo when there is context to promote — presents them as a single summary, and asks "Merge all?" The pull requests merge together or none does.

## Parallel Tasks

Because each task has its own branch and its own worktrees, several can be worked on at the same time, in one chat or in several. Open a terminal, start or pick up a task, and work. Open another terminal and do the same with a different one. They do not interfere with each other.

```
Chat 1:                                     Chat 2:
Task: fix-auth                              Task: add-search
Branch: bugfix/fix-auth                     Branch: feature/add-search
Repos: my-app, my-api                       Repos: my-app
```

Both tasks can touch the same repo (in this example, both include `my-app`) because each has its own worktree. Git worktrees share the object store but have independent working directories and indexes.

## Resuming Across Conversations

A task is picked up again by its issue. `/start-work gh:42` checks whether a chat already has a task for that issue. If one does, it makes sure the worktrees are there and asks which way to take it: adopt the task into this chat, leave it with the chat that owns it, or — when that chat is this one — simply continue. On another machine the same command builds the worktrees from the branch that was pushed.

What the next chat knows about the work is what was put on disk. `/handoff` captures where things stand and what comes next, and `/start-work handoff` lists the handoffs to resume from. A task started with no tracker has no issue to resume from, so its handoff carries the next steps instead.

## Local mode

A repo whose origin is not a forge — no origin remote at all, or `merge: "local"` under `repos.{repo}` in `workspace.json` (`workspace.merge` for the workspace repo `.`) — completes the task in **local mode**: nothing is pushed and no PR is opened for it. The override exists for a clone whose origin is a third-party upstream nobody here may push to; an origin that is neither forge-hosted nor overridden stops completion with the setting spelled out. Merging a local repo fast-forwards its default branch in the repo's own source clone (`repos/{repo}`, or the launcher for `.`), which must be sitting clean on that branch; a branch that will not fast-forward stops the run and asks for a rebase first. The ordering is unchanged — project repos first, the workspace repo last — and mixed forge/local tasks complete in one run. A workspace with no tracker works the same way: the task is recorded keyed by repo + branch, and completion simply has no issue to close.

## CI checks and merge approval

Before anything merges, the CI of every PR is read through the forge adapter — GitHub's `gh pr checks`, GitLab's head pipeline — and the gate is all-or-nothing: one red or still-running PR stops the whole completion with nothing merged, because a task's PRs describe each other and may not land part-way. The stop lists every PR's state; re-running once checks finish picks the task back up, and `--wait` polls instead — every still-pending PR each round, then one final read of all of them before anything merges so a PR that went red during the wait is caught — up to a timeout. Checks can lag PR creation, so a PR opened within the last 90 seconds that reports no checks is re-read — all such PRs per round behind one shared pause — twice at most before "none" is accepted. A repo with no CI and a green one both proceed; a GitLab pipeline waiting on a manual job says so; `--skip-checks` is the escape hatch, recorded in the output rather than passed silently. Local-mode repos have no forge to ask, so no checks gate them.

Who says merge is the `mergeApproval` setting: `ask` (the default) keeps one question after the summary that merges everything, while `operator` has completion stop after the PRs are created and their checks read, reporting the links and leaving the merging to a person. One `operator` entry anywhere governs the whole task — the workspace PR cannot merge ahead of the code PRs it describes, so the task cannot merge part-way. The operator either says merge in a later turn (the merge command then runs with `--approved`, which it demands otherwise) or merges without the command — in the forge UI, or for a local-mode repo by fast-forwarding the branch into its default branch by hand — where the completion re-run detects the merged PRs and carries on to the close and teardown. The setting is per repo — `repos.{repo}.mergeApproval`, or `workspace.mergeApproval` for the workspace repo `.`.

A long multi-chat effort is a task too. Its thinking lives in the chat's drawer until completion routes it.

## Sessions from Earlier Versions

A workspace made on an earlier version of the template may still hold **sessions**, the lifecycle those versions had. A session was a coherent piece of effort spanning one or more conversations, kept in a self-contained `work-sessions/{name}/` folder with a workspace worktree, nested project worktrees and a `session.md` tracker. That lifecycle is removed: no skill starts, resumes or completes a session now.

Upgrading moves nothing and deletes nothing. The folders stay where they are, and three things report how many there are until they are drained: a line from the session-start hook, an info finding in the maintenance audit, and a line in `/workspace-update`'s report. Each counts the sessions directory's entries whose names do not start with a dot, so an archive under `.archived/` never counts. A chat opened inside one of their worktrees is pointed the same way: `/complete-work` finds no task there and names `/migrate-sessions`, and so does the line the repo-write-detection hook adds to its warning.

An older `workspace.json` may still carry two keys from that lifecycle, because an update never removes a key. `sessionModel` selects nothing and is read by nothing. `workSessionsDir` only names where the leftover sessions sit, `work-sessions` by default.

## Migrating an Existing Workspace

A workspace that grew up on sessions drains them with `/migrate-sessions`. Every entry under the sessions directory is work from before the task lifecycle, and this skill is how each one leaves. It inventories the directory and proposes one of six outcomes per session — **MERGEABLE** (real content survives: files on the branch, commits ahead in a project repo, or uncommitted work), **ABANDONED** (stale, artifact-only), **ACTIVE** (worked on recently), **UNKNOWN** (no activity signal at all — never assumed abandoned), **ORPHAN_SHELL** (a broken folder with no worktree left), or **LEAVE** (a symlinked "foreign" entry that is never followed) — with the evidence behind each: recency, content beyond session artifacts, commits ahead, per-remote divergence, and whether anything exists on a remote. Proposals are only proposals: the operator decides each session, one at a time, and every session leaves one of three ways.

A session is **finished** when its work should land. The skill rebases the session's worktrees, graduates or strips the session artifacts so none of them reaches the default branch, and hands the push, the PRs, the ordered merge and the issue close to `.claude/scripts/task-pr.mjs`, the task lifecycle's own script, pointed at the session's worktrees with `--worktree`. The folder is archived once everything has merged; after a squash merge that archive asks for `--allow-unbacked`, because the branch's own commits are on no remote although their content is on the default branch.

A session is **archived** when its work should not land. The folder moves to `work-sessions/.archived/`, git's worktree links follow it, and every commit and file comes along. Before that, an optional backup tags each session's branches as `drain/{session}/…` locally and pushes those tags only to remotes the operator explicitly allows — never to a third-party upstream or a read-only mirror.

An **orphan shell** is removed only after a scripted second check finds nothing but empty directories in it. That is the one deletion the migration performs: every other file, commit, and untracked edit either stays in place or rides into the archive, and deleting an archive later is a separate, manual decision.

A session still being worked is left for a later run. Nothing resumes it as a session, so it leaves through Finish or Archive when the operator is ready for either.

The skill can also write `workspace.sessionModel: "task"` on a branch — merged through a PR when the workspace repo has a forge remote, or fast-forwarded locally when it has none — never as a direct edit on the launcher's tracked `workspace.json`. The template no longer carries the key. The write only keeps an older file from still saying `"session"`, and it routes nothing.

The rule that holds it together: a migration only ever touches the workspace it runs in. Never point it at another workspace, and never batch several workspaces through one run — each workspace drains its own sessions from its own root.

---

## Key Takeaways

- Work is a task: one issue, one branch, one worktree per repo it touches. There is no folder and no tracker file, and nothing in `workspace.json` selects a lifecycle.
- A task's state is the issue, the branch, and the chat's record and drawer under `workspace-scratchpad/`. Both are machine-local, which is why what another chat needs goes on the issue.
- A task's worktrees live at `repos/{repo}/.claude/worktrees/{slug}/`, and at `.claude/worktrees/{slug}/` for the workspace repo itself. The source clones are never disturbed.
- Multi-repo tasks share one branch name across all repos for traceability, and their pull requests merge together or not at all.
- Parallel tasks run in separate worktrees, in one chat or several, without conflict.
- Sessions from earlier versions are resumed and completed by no skill. `/migrate-sessions` is how each one leaves: finished, archived, or — for an empty shell — removed.
