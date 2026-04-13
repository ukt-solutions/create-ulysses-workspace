---
name: sync-work
description: Push branches without ceremony — all project and workspace repos. No PR, no status change, no forced capture. Use for backing up work in progress.
---

# Sync

Push current branches to remote for all project repos and the workspace repo. Lightest-touch backup — no PRs, no lifecycle changes, no forced context capture.

## Flow

**Step 1: Detect active branches**
```bash
# Workspace worktree
cd work-sessions/{session-name}/workspace
git branch --show-current

# Project worktree(s) — for each repo in the session tracker's repos:
git -C work-sessions/{session-name}/workspace/repos/{repo} branch --show-current
```

**Step 2: Check for uncommitted changes**
For each repo in the session tracker's `repos:` list plus the workspace:
```bash
cd work-sessions/{session-name}/workspace/repos/{repo}
git status --short
```
If uncommitted changes exist: "You have uncommitted changes in {repo}. Commit before syncing? [Y/n]"
If yes: ask for a commit message or suggest one based on the changes.
If no: skip that repo (can't push uncommitted work).

**Step 3: Check for remotes**
For each repo in the session tracker's `repos:`:
```bash
cd work-sessions/{session-name}/workspace/repos/{repo}
git remote -v
```
If no remote: "No remote configured for {repo}. Want me to create one on GitHub, or provide a URL?"
Create via `gh repo create` or add the provided URL. Never silently skip.

**Step 4: Push**
For each repo with committed changes and a remote:
```bash
cd work-sessions/{session-name}/workspace/repos/{repo}
git push -u origin {branch-name}
```

Then push the workspace repo from the workspace worktree:
```bash
cd work-sessions/{session-name}/workspace
git push -u origin {branch-name}
```

The tracked session files (`session.md`, `design-*.md`, `plan-*.md`) ride along with the workspace push — that's how durable session thinking reaches another machine.
Report per repo: "Synced: {repo} ({branch-name}) pushed to origin."

**Step 5: Optionally offer capture**
"Want to /braindump or /handoff while syncing? [n/Y]"
Default is no — /sync-work is about backing up, not capturing. But the offer is there.

## Three Intents, Three Skills

| Skill | Intent | What happens |
|---|---|---|
| /pause-work | Stopping, someone else might pick up | Capture + push + draft PR + mark paused |
| /complete-work | Done with this branch | Synthesize + push + real PR + resolve context |
| /sync-work | Still working, just backing up | Push + no PR + no status change |

## Notes
- No PRs created — this is a checkpoint, not a milestone
- No lifecycle changes — context stays `active`
- All repos pushed if they have branches with changes
- Safe to run repeatedly — just pushes latest commits
