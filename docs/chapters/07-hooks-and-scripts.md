# Hooks and Scripts

Hooks and scripts are the automation layer of the workspace. Hooks fire automatically in response to Claude Code events — a conversation starting, context being compacted, a subagent launching. Scripts consolidate mechanical git sequences that skills need to run. Together, they handle the work that should happen without you thinking about it.

This chapter explains what hooks and scripts do, when they fire, and how they work.

---

## What Hooks Are

A hook is a Node.js script in `.claude/hooks/` that runs automatically when Claude Code emits an event. You do not invoke hooks — they fire on their own. Their job is to inject context, enforce constraints, or record state at key moments in the conversation lifecycle.

Hooks communicate with Claude through a simple mechanism: they can return an `additionalContext` string that gets injected into Claude's context for the current turn. This is how hooks influence behavior without requiring user action. A hook can say "you have an active work session" or "you are about to write to a repo outside your session" and Claude will see that information and act on it.

The workspace ships with nine hook scripts. `.claude/settings.json` registers them across six Claude Code events; one of them, `workspace-update-check`, is registered on two:

| Event | Hooks under `.claude/hooks/` |
|---|---|
| `SessionStart` | `workspace-update-check.mjs`, `session-start.mjs`, `version-freshness-check.mjs` |
| `SubagentStart` | `subagent-start.mjs` |
| `PreCompact` | `pre-compact.mjs` |
| `PostCompact` | `post-compact.mjs` |
| `PreToolUse` | `workspace-update-check.mjs`, `repo-write-detection.mjs`, `bash-output-advisory.mjs` |
| `SessionEnd` | `session-end.mjs` |

## Hook Inventory

The hooks below follow that table, so each entry can be checked against `settings.json`. `workspace-update-check` has one entry although it is registered on two events.

### workspace-update-check

**Fires:** When a Claude Code conversation begins, and then on every tool call (`SessionStart` and `PreToolUse`).

**Does:** Checks whether a `.workspace-update/` directory exists. That directory means the CLI has staged a template payload — a first-time init or an upgrade — that has not been applied yet. If there is none, the hook exits without saying anything. If there is, it reads the payload's manifest and injects a message marked `MANDATORY`: read the staged skill's `SKILL.md` (`workspace-init` for an init payload, `workspace-update` for an upgrade) and follow it before doing anything else. An upgrade message names both versions, and a payload staged more than five minutes ago is called out as one that survived a previous session. [Chapter 10](10-installation-and-upgrades.md) covers the upgrade flow.

### session-start

**Fires:** When a new Claude Code conversation begins.

**Does:** What it reports depends on where the chat starts.

Inside a session's workspace worktree, it registers the chat in the session tracker's `chatSessions` frontmatter and names the active session and the main workspace root.

At the workspace root, it begins with the workspace name and a one-line summary of `workspace.json` (`Workspace config (workspace.json):` — session model, tracker, forge, repo names), which is why CLAUDE.md no longer imports workspace.json itself. It then names this chat's record (`Chat record:`) and the workspace root (`Workspace root:`), so skills never have to derive either. It points at `/workspace-init` when this machine is missing something that skill provides — repos that are not cloned yet, a user identity, or `CLAUDE.local.md`. When `workspace.json` has a team roster, it adds a `Team identity:` line for each way this machine disagrees with it. That covers a `workspace.user` that is an alias or missing from the roster, and git committing as another member. Each finding names its fix, and none needs the network. It fetches each cloned project repo (best effort) and reports `Repos synced:`.

It then brings the workspace repo's `repo-{name}` remotes in step with the clones, through [repo-remotes.mjs](#repo-remotesmjs), so that a pull request opened in a project repo is matched to a chat at the workspace root. A `Repo remotes:` line follows only when a remote was added, updated, removed or adopted, or when a clone could not get one: every session pays for each line, and on an ordinary launch there is nothing to say.

It then lists two kinds of prior work, so the conversation starts aware of them. Every work session that has a tracker under `work-sessions/` is listed with its status, description, branch, repos and worktree path, so Claude can offer to resume one; a session whose worktree is gone is marked orphaned. And the team-visible files under `workspace-context/shared/` are listed by topic, lifecycle and last update under a `Workspace context:` heading.

If there is no `workspace.json`, it says so and points at `/workspace-init` instead.

This is how `/start-work` knows about existing sessions — the hook has already told Claude what is available before you type anything.

### version-freshness-check

**Fires:** When a new Claude Code conversation begins.

**Does:** Refreshes the template-freshness banner that CLAUDE.md imports under Workspace Config (`local-only-template-freshness.md`). It compares the workspace's `templateVersion` with the newest template on its release channel, asking the npm registry at most once every 24 hours and showing the last known state in between. The hook injects nothing itself and never stops a session from starting, even when the registry cannot be reached. Set `workspace.versionCheck.ambient` to `false` to turn the check off.

### subagent-start

**Fires:** When Claude Code launches a subagent (a separate Claude instance for a subtask).

**Does:** Injects the workspace's canonical truths — the files in `workspace-context/shared/locked/` — into the subagent's context. Subagents do not load CLAUDE.md, so they start with no conversation history and no team context unless something provides it. This hook solves that structurally: every subagent automatically receives team knowledge without anyone remembering to provide it.

Not every file is pasted in whole. A locked file is inlined, with its frontmatter stripped, when it is at most `workspace.subagentInlineMaxBytes` (8 KB from the template). A longer one becomes a one-line pointer giving the file's name, description and size, for the subagent to read if its task touches it. Gitignored files and `local-only-*` files are never included. If the inlined files together exceed `workspace.subagentContextMaxBytes` (32 KB), the largest are turned into pointers first, until the total fits.

This is one of the most important hooks in the workspace. Without it, subagents would need explicit context pasted into every dispatch. With it, team truths arrive automatically.

### pre-compact

**Fires:** Before Claude Code compresses the conversation context (when the context window is getting full).

**Does:** Checks the session state and suggests capture. Inside an active work session it looks at when the session tracker file was last modified. If that was more than 30 minutes ago, it suggests `/handoff`, so the tracker reflects the conversation before the context is compressed. If the tracker is recent, it says so and notes that earlier conversation details may still be lost. Outside a session it suggests `/braindump` or `/handoff`. This is the automatic "you are about to lose context, want to save anything?" prompt.

The full conversation is still available when this hook fires — it is the last chance to capture before compaction removes older messages.

### post-compact

**Fires:** After context compaction completes.

**Does:** Injects a short reminder that earlier context was compacted and that discussion details from before that point may be incomplete. It suggests `/braindump` or `/handoff` for any decision or progress not yet captured, to be run now, while they are still remembered.

### repo-write-detection

**Fires:** On every tool call (`PreToolUse`). It acts only on Bash, Edit and Write.

**Does two things:**

First, when running from the workspace root (the launcher, on its default branch), it enforces write restrictions. Only `workspace-scratchpad/`, `local-only-*` files and the task model's worktrees (`repos/{repo}/.claude/worktrees/{slug}/` and `.claude/worktrees/{slug}/`) are writable from the root. Attempts to write to the source clones in `repos/`, to `workspace-context/`, to `work-sessions/`, or to the template files under `.claude/` trigger a warning telling Claude that work belongs in a worktree. A Bash command that starts with `git`, `ls`, `cat` or another utility from a short list of read-only ones passes without a warning, and so does a `node` invocation of a script under `.claude/scripts/`.

Second, when running from a workspace worktree with an active session, it detects writes to repos that are not part of the session. If you try to write to `my-api` but your session only includes `my-app`, the hook warns Claude so it can offer to add the repo to the session before proceeding.

### bash-output-advisory

**Fires:** On every tool call (`PreToolUse`). It acts only on Bash.

**Does:** Gives a one-line advisory when a command is likely to flood the context with output. It recognizes four shapes: a test runner with nothing scoping it (`npm test`, `cargo test`), a recursive `grep` without `--include` or `--exclude`, `find` on `/` or the home directory without `-name` or `-path`, and `cat` on a `.log`, `.jsonl` or `.ndjson` file. The advisory suggests scoping the command — a path, a filter, or a pipe to `head`, `tail` or `grep`. A command already piped to a bounding command, or redirected to a file, gets none. The hook never modifies or blocks the command: the model decides what to do with the hint. Its patterns are deliberately narrow, because a false positive teaches the model to ignore the hook.

### session-end

**Fires:** When a Claude Code conversation ends.

**Does:** Records that this chat has ended, and always appends an entry to the disposable session log at `workspace-scratchpad/session-log.jsonl`.

Inside an active work session it does three more things. It marks this chat's `ended` timestamp in the session tracker — the timestamp resume uses to tell whether work happened after the tracker was last updated. It appends a short "Session ended" note to the tracker's body and commits it on the session branch, so the next chat can see that the previous one closed without capturing explicitly. And it reads the tracker's Progress section for correction-shaped sentences ("actually", "instead of", "I was wrong") and records any it finds in `workspace-scratchpad/session-reflect.json`, a best-effort reflection record.

## What Scripts Are

Scripts are Node.js files in `.claude/scripts/` that consolidate mechanical git sequences. Skills call them — you do not call them directly. They exist to reduce the number of individual shell commands that skills need to issue, which reduces token overhead and error surface.

The command scripts take explicit arguments, fail loudly on errors, and print a JSON result for the calling skill to parse. Some serve the session lifecycle and some the task lifecycle; both are listed below.

Two of these files are adapter layers rather than command sequences: `.claude/scripts/forges/interface.mjs` and `.claude/scripts/trackers/interface.mjs`. Skills never call `gh` or `glab` directly for pull-request, release, workflow-run, or issue operations — they call `createForge()` / `createTracker()`, which dispatch to a `github` or `gitlab` module behind a single method surface. The adapter choice lives in `workspace.json` (`workspace.forge.type`, with `workspace.forge.host` naming a self-managed GitLab), and when no type is set, each repo's own origin host picks its adapter — so one workspace can mix GitHub and GitLab repos.

The tracker adapters also share an epic surface — `listEpics()`, `getEpic()`, `createEpic()`, `setIssueEpic()`, `listEpicIssues()` — the same method surface on both backends. By default an epic is the label `epic:{name}` carried by every issue in it (the prefix is configurable via `workspace.tracker.epicLabelPrefix`); GitLab Premium instances can instead set `workspace.tracker.epics: "native"` to use group epics — and when those endpoints answer 403/404 (no Premium licence, no group access), the adapter throws an error pointing back at label mode rather than silently downgrading. `/start-work` reads the epic list before creating a new issue and offers an epic picker once any epic exists.

### create-work-session.mjs

Creates everything a work session needs: the `work-sessions/{name}/` folder, workspace branch and worktree, project branches and nested worktrees (one per repo) inside the workspace worktree's real `repos/` directory, settings copy, active-session pointer, and the unified `session.md` tracker.

```bash
node .claude/scripts/create-work-session.mjs \
  --session-name "fix-auth" \
  --branch "bugfix/fix-auth" \
  --repo "my-app,my-api" \
  --user "alice" \
  --description "Fix authentication timeout"
```

### cleanup-work-session.mjs

Removes everything a work session created: workspace worktree, all project worktrees, local branches in all repos, workspace branch, and the session folder.

```bash
node .claude/scripts/cleanup-work-session.mjs \
  --session-name "fix-auth"
```

### add-repo-to-session.mjs

Adds a repo to an existing session mid-flight. Creates the branch and worktree nested inside the workspace worktree's `repos/` directory, and updates the session tracker's `repos:` frontmatter.

```bash
node .claude/scripts/add-repo-to-session.mjs \
  --session-name "fix-auth" \
  --repo "my-api"
```

### task-worktree.mjs

Creates, removes and detects the worktrees of the task lifecycle, where a task is one issue, one branch and one worktree per repo it touches. `--create` makes a worktree at `repos/{repo}/.claude/worktrees/{slug}/` — the same location Claude Code's own worktree feature uses — or at `.claude/worktrees/{slug}/` for the workspace repo itself, which is addressed as `.`. `--remove` tears one down. `--detect` works out which task or session the chat is working on; because a task's chat stays at the workspace root rather than inside a worktree, it consults the chat record and the session trackers as well as the current directory. [Chapter 2](02-work-sessions.md#the-task-model) covers the flow.

```bash
node .claude/scripts/task-worktree.mjs --root . --create --repo "my-app" --branch "bugfix/fix-auth"
node .claude/scripts/task-worktree.mjs --root . --remove --repo "my-app" --branch "bugfix/fix-auth"
```

### chat-record.mjs

Reads and updates the chat record at `workspace-scratchpad/chats/{chat}.json`: the tasks a chat has open, each with its work item, branch and repos. `--add-task` and `--remove-task` change that list, `--whoami` recovers the chat's own name, and `--owner` names the chat that owns a work item's open task.

```bash
node .claude/scripts/chat-record.mjs --root . --add-task --chat "fix-login" --work-item "gh:42" --branch "bugfix/fix-auth" --repo "my-app"
node .claude/scripts/chat-record.mjs --root . --owner "gh:42"
```

### task-pr.mjs

The task lifecycle's pull-request step, in three commands. `--create` pushes each branch and opens one PR per repo, and writes a JSON description of the run to `--out`. `--checks` reads every PR's CI state without merging anything. `--merge` merges the PRs in order and closes the linked issue. The last two take that JSON file as `--prs`. A repo with no forge remote is neither pushed nor given a PR; `--merge` fast-forwards its default branch instead. [Chapter 2](02-work-sessions.md#the-task-model) has the full sequence, including merge approval.

```bash
node .claude/scripts/task-pr.mjs --checks --root . --prs "workspace-scratchpad/chats/fix-login/prs-bugfix-fix-auth.json"
```

### team-roster.mjs

Reads and maintains the team roster in `workspace.json` → `workspace.team`. The roster is keyed by `team-member/` folder name, and each entry may carry a display `name`, a `forge` login (or a list of them), `gitEmails` and `aliases`. All fields are optional, and a workspace without a roster has every identity check off. The script also manages the machine-local `workspace.user` that points into the roster. `/workspace-init`, `/maintenance`, `/pause-work` and `/complete-work` call it; you run it yourself mainly to add your entry.

```bash
node .claude/scripts/team-roster.mjs --suggest                      # default name for this machine
node .claude/scripts/team-roster.mjs --whoami                       # who this machine is, and its @handle
node .claude/scripts/team-roster.mjs --check                        # roster, folders and this machine
node .claude/scripts/team-roster.mjs --add alice --name "Alice" --detect   # record this machine's login and email
node .claude/scripts/team-roster.mjs --set-user alice               # point this machine at a member
node .claude/scripts/team-roster.mjs --merge-alias alicew [--apply] # merge an alias's folder into its owner's
```

`--add` edits `workspace.json` (a tracked change) and refuses a result that would give one login or email to two people. `--merge-alias` is a dry run until `--apply`. It moves tracked files with `git mv`, so history follows them, and moves symlinks as links without following them. It stops before moving anything if a path exists in both folders, even if only the case differs, or if a tracked file is missing from disk. A merge that fails part-way can be finished by running it again.

### repo-remotes.mjs

Gives the workspace repo one remote per project clone, named `repo-{name}` and carrying the clone's origin. Claude Code Desktop decides whether a pull request belongs to a chat by comparing the PR's `owner/name` with every git remote of the chat's folders. A chat runs at the workspace root, whose own remote is the workspace repo, so without these a pull request opened in a project repo is not matched to the chat.

```bash
node .claude/scripts/repo-remotes.mjs --root .               # bring the remotes in step with repos/
node .claude/scripts/repo-remotes.mjs --root . --json        # the same, printing what changed as JSON
node .claude/scripts/repo-remotes.mjs --root . --remove-all  # take the remotes away again
```

Such a remote exists to be matched, nothing more. Its push URL is the sentinel `no-push`, which no push can resolve. `git fetch --all` and `git remote update` skip it. It has no fetch refspec, so a fetch by name writes `FETCH_HEAD` alone and no `refs/remotes/repo-*` branch ever appears. It therefore holds no remote-tracking branches: the ones a hand-made remote had already fetched are deleted when it is adopted, and deleted whenever a managed remote is removed, because `git remote remove` leaves behind every ref that does not match a refspec. `origin` and every other remote of the workspace repo are never touched, their tracking branches included.

One run brings the remotes in step with `repos/`: it adds a remote for a clone that has none, updates one whose clone's origin has changed, adopts a `repo-{name}` remote that was made by hand with the same sentinel as its push URL, and removes one when the clone's directory is gone. Only a missing directory removes a remote. A clone that is there but cannot be read at that moment — git timed out, or its `.git` or its origin is missing — keeps the remote it has and is reported as skipped, so a slow moment never takes a remote away only for the next launch to add it back. It is safe to run at any time, and a second run changes nothing. The session-start hook runs it at every launch, and `/workspace-init` runs it after cloning, so there is rarely a reason to run it yourself. Without `--json` it prints one line per change, and nothing when nothing changed.

`workspace.repoRemotes: false` in `workspace.json` turns the feature off by undoing it: from then on the session-start hook removes every `repo-{name}` remote the script made or adopted, and adds none. Every other remote is left as it is. `--remove-all` does the same once, whatever `workspace.json` says.

## How Hooks and Scripts Work Together

The layers interact in a clear pattern:

**Hooks detect conditions.** session-start lists the existing sessions and this chat's record. pre-compact notices a session tracker that has gone stale. repo-write-detection detects out-of-scope writes.

**Skills make decisions.** When Claude receives a hook's context injection, it uses skill knowledge to decide what to do. "There's an active session" leads to offering resume. "There's uncaptured work before compaction" leads to suggesting capture.

**Scripts execute mechanics.** When a skill decides to create a session, it calls create-work-session.mjs. When it decides to clean up, it calls cleanup-work-session.mjs. The task lifecycle keeps the same split: `/start-work` calls task-worktree.mjs for each worktree and records the task with chat-record.mjs, and `/complete-work` hands the push, PR and merge sequence to task-pr.mjs. The skill handles the judgment; the script handles the git operations.

This separation means hooks are simple (detect and report), skills are expressive (decide and guide), and scripts are mechanical (execute and confirm). No layer tries to do another layer's job.

---

## Key Takeaways

- Hooks fire automatically on Claude Code events. You do not invoke them.
- The workspace ships nine hook scripts across six events; `.claude/settings.json` is the list to check them against.
- Hooks influence behavior through `additionalContext` injection — adding information to Claude's context at key moments.
- The subagent-start hook is critical — it carries the locked context to every subagent, inlining the short files and pointing to the long ones.
- Scripts consolidate mechanical git sequences that skills invoke. They take explicit arguments and return JSON.
- The pattern: hooks detect, skills decide, scripts execute.
