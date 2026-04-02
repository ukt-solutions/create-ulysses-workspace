---
name: sync
description: Push branches without ceremony — both project and workspace repos. No PR, no status change, no forced capture. Use for backing up work in progress.
---

# Sync

Push current branches to remote for both the project repo and workspace repo. Lightest-touch backup — no PRs, no lifecycle changes, no forced context capture.

## Flow

**Step 1: Detect active branches**
```bash
# Workspace repo
git branch --show-current

# Project repo(s) — check worktrees
git -C repos/{repo} worktree list
```

**Step 2: Check for uncommitted changes**
For each repo with an active branch:
```bash
git status --short
```
If uncommitted changes exist: "You have uncommitted changes in {repo}. Commit before syncing? [Y/n]"
If yes: ask for a commit message or suggest one based on the changes.
If no: skip that repo (can't push uncommitted work).

**Step 3: Check for remotes**
For each repo:
```bash
git remote -v
```
If no remote: "No remote configured for {repo}. Want me to create one on GitHub, or provide a URL?"
Create via `gh repo create` or add the provided URL. Never silently skip.

**Step 4: Push**
For each repo with committed changes and a remote:
```bash
git push -u origin {branch-name}
```
Report: "Synced: {repo} ({branch-name}) pushed to origin."

**Step 5: Optionally offer capture**
"Want to /braindump or /handoff while syncing? [n/Y]"
Default is no — /sync is about backing up, not capturing. But the offer is there.

## Three Intents, Three Skills

| Skill | Intent | What happens |
|---|---|---|
| /pause-work | Stopping, someone else might pick up | Capture + push + draft PR + mark paused |
| /complete-work | Done with this branch | Synthesize + push + real PR + resolve context |
| /sync | Still working, just backing up | Push + no PR + no status change |

## Notes
- No PRs created — this is a checkpoint, not a milestone
- No lifecycle changes — context stays `active`
- Both repos pushed if both have branches with changes
- Safe to run repeatedly — just pushes latest commits
