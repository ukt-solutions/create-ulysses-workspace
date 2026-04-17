# Hooks and Scripts

Hooks and scripts are the automation layer of the workspace. Hooks fire automatically in response to Claude Code events — a conversation starting, context being compacted, a subagent launching. Scripts consolidate mechanical git sequences that skills need to run. Together, they handle the work that should happen without you thinking about it.

This chapter explains what hooks and scripts do, when they fire, and how they work.

---

## What Hooks Are

A hook is a Node.js script in `.claude/hooks/` that runs automatically when Claude Code emits an event. You do not invoke hooks — they fire on their own. Their job is to inject context, enforce constraints, or record state at key moments in the conversation lifecycle.

Hooks communicate with Claude through a simple mechanism: they can return an `additionalContext` string that gets injected into Claude's context for the current turn. This is how hooks influence behavior without requiring user action. A hook can say "you have an active work session" or "you are about to write to a repo outside your session" and Claude will see that information and act on it.

The workspace ships with eight hooks. The design philosophy is minimal intervention — two surgical hooks, not a framework of automation. Each hook does one thing and does it quietly.

## Hook Inventory

### session-start

**Fires:** When a new Claude Code conversation begins.

**Does:** Walks `work-sessions/` for any `session.md` trackers and surfaces active work sessions. If there are active or paused sessions, it injects a summary so Claude can offer to resume them. Also surfaces recent handoffs so the conversation starts with awareness of prior work.

This is how `/start-work` knows about existing sessions — the hook has already told Claude what is available before you type anything.

### session-end

**Fires:** When a Claude Code conversation ends.

**Does:** Records the chat session's end timestamp in the active session marker. This timestamp is used by history reconstruction — when you resume a session, the system checks whether work was captured between the previous chat's end and the tracker's last update.

### pre-compact

**Fires:** Before Claude Code compresses the conversation context (when the context window is getting full).

**Does:** Analyzes the session state and suggests capture. If there is an active work session with uncaptured discussion, it nudges Claude to suggest `/braindump` or `/handoff` before the context is compressed. This is the automatic "you are about to lose context, want to save anything?" prompt.

The full conversation is still available when this hook fires — it is the last chance to capture before compaction removes older messages.

### post-compact

**Fires:** After context compaction completes.

**Does:** Injects a gentle reminder that context was compressed. This helps Claude (and you) be aware that earlier conversation details may no longer be in memory, so important decisions should be verified against shared context rather than recalled from conversation.

### subagent-start

**Fires:** When Claude Code launches a subagent (a separate Claude instance for a subtask).

**Does:** Injects the contents of `shared-context/locked/` into the subagent's context. Subagents start with zero conversation history — they know nothing about the project unless they are told. This hook solves that structurally: every subagent automatically receives team knowledge without anyone remembering to provide it.

This is one of the most important hooks in the workspace. Without it, subagents would need explicit context pasted into every dispatch. With it, team truths arrive automatically.

### repo-write-detection

**Fires:** On every file-writing tool call (PreToolUse event for Bash, Edit, Write).

**Does two things:**

First, when running from the workspace root (main branch), it enforces write restrictions. Only `workspace-scratchpad/` and `local-only-*` files are writable from the root. Attempts to write to repos, shared context, template files, or session folders trigger a warning telling Claude to use a workspace worktree.

Second, when running from a workspace worktree with an active session, it detects writes to repos that are not part of the session. If you try to write to `my-api` but your session only includes `my-app`, the hook warns Claude so it can offer to add the repo to the session before proceeding.

### worktree-create

**Fires:** When a git worktree is created.

**Does:** Performs post-creation setup for new worktrees — ensuring the workspace structure is correct in the new worktree.

### workspace-update-check

**Fires:** On every tool call (PreToolUse event).

**Does:** Checks whether a `.workspace-update/` directory exists, indicating that a template update has been staged by the CLI. If found, it nudges Claude to suggest running `/workspace-update`. This is a fast check — it calls `existsSync` and exits immediately if no update is pending.

## What Scripts Are

Scripts are Node.js files in `.claude/scripts/` that consolidate mechanical git sequences. Skills call them — you do not call them directly. They exist to reduce the number of individual shell commands that skills need to issue, which reduces token overhead and error surface.

Each script takes explicit arguments, fails loudly on errors, and prints a JSON result for Claude to parse.

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

Removes everything a work session created: workspace worktree, all project worktrees, local branches in all repos, workspace branch, and session marker.

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

## How Hooks and Scripts Work Together

The layers interact in a clear pattern:

**Hooks detect conditions.** session-start detects active sessions. pre-compact detects uncaptured work. repo-write-detection detects out-of-scope writes.

**Skills make decisions.** When Claude receives a hook's context injection, it uses skill knowledge to decide what to do. "There's an active session" leads to offering resume. "There's uncaptured work before compaction" leads to suggesting capture.

**Scripts execute mechanics.** When a skill decides to create a session, it calls create-work-session.mjs. When it decides to clean up, it calls cleanup-work-session.mjs. The skill handles the judgment; the script handles the git operations.

This separation means hooks are simple (detect and report), skills are expressive (decide and guide), and scripts are mechanical (execute and confirm). No layer tries to do another layer's job.

---

## Key Takeaways

- Hooks fire automatically on Claude Code events. You do not invoke them.
- Hooks influence behavior through `additionalContext` injection — adding information to Claude's context at key moments.
- The subagent-start hook is critical — it injects locked context into every subagent automatically.
- Scripts consolidate mechanical git sequences that skills invoke. They take explicit arguments and return JSON.
- The pattern: hooks detect, skills decide, scripts execute.
