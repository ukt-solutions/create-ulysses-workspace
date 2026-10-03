---
name: setup-tracker
description: Configure an issue tracker for this workspace — writes workspace.json → tracker block and initializes labels. GitHub Issues and GitLab Issues are the shipped backends; others can be added by dropping an adapter at .claude/scripts/trackers/{type}.mjs. Runnable during /workspace-init or standalone.
---

# Setup Tracker

Wire this workspace up to an external issue tracker. The tracker becomes the source of truth for all work items; the workspace does not maintain a local mirror.

## Prerequisites

- `.claude/rules/work-item-tracking.md` should be active. If missing, warn but continue.
- The adapter for the chosen backend must exist at `.claude/scripts/trackers/{type}.mjs`. The template ships `github-issues.mjs` and `gitlab-issues.mjs`.

## Flow

### Step 1: Check current state

Read `workspace.json` → `workspace.tracker`. If already configured: "Tracker is {type} on {repo}. Reconfigure? [y/N]." If declined, exit.

### Step 2: Pick a backend

Offer the backend that matches the workspace's own remote first — run `git -C {workspace-root} remote get-url origin` and suggest GitLab Issues when the host is `gitlab.com` or the workspace's configured GitLab `host`, GitHub Issues otherwise. Then ask: "Which issue tracker?"
1. GitHub Issues (shipped)
2. GitLab Issues (shipped)
3. Linear — not yet supported
4. Jira — not yet supported
5. None — skip

For (3) and (4): tell the user the adapter isn't shipped and exit. To add one, write a module at `.claude/scripts/trackers/{type}.mjs` that implements the contract in `.claude/scripts/trackers/interface.mjs`.

For (5): exit — no changes.

### Step 3: GitHub Issues configuration

1. **Verify `gh` auth.** Run `gh auth status`. If not authenticated, walk the user through `gh auth login`. Do not proceed until authenticated.

2. **Resolve the target repo.** Default to the workspace's own git remote:
   ```bash
   git -C {workspace-root} remote get-url origin
   ```
   Parse the GitHub slug. Ask: "Use `{slug}` for issues, or a different repo?" If the user wants a different repo, accept any `owner/name` slug.

3. **Verify issues are enabled:**
   ```bash
   gh repo view {slug} --json hasIssuesEnabled
   ```
   If `hasIssuesEnabled` is `false`, offer: "Issues are disabled on `{slug}`. Enable? [Y/n]" → `gh api repos/{slug} -X PATCH -f has_issues=true`.

4. **Write `workspace.json`:**
   ```json
   {
     "workspace": {
       "tracker": {
         "type": "github-issues",
         "repo": "{slug}"
       }
     }
   }
   ```
   Preserve all other fields. Commit:
   ```bash
   git add workspace.json
   git commit -m "chore: configure github-issues tracker on {slug}"
   ```

5. **Initialize labels** by calling the adapter's `ensureLabels()` from a shell one-liner:
   ```bash
   node --input-type=module -e "
     import { createTracker } from './.claude/scripts/trackers/interface.mjs';
     import { readFileSync } from 'node:fs';
     const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
     const t = createTracker(ws.workspace.tracker);
     await t.ensureLabels();
     console.log('Labels initialized.');
   "
   ```
   Creates the six standard labels: `bug`, `feat`, `chore`, `P1`, `P2`, `P3`.

6. **Optional: create milestones.** Ask if the user wants a starter milestone list (e.g., `Backlog`, `v0.1 — Alpha`, `v1.0 — Launch`). If yes, call the adapter for each — idempotent, so re-running setup won't duplicate:
   ```bash
   node --input-type=module -e "
     import { createTracker } from './.claude/scripts/trackers/interface.mjs';
     import { readFileSync } from 'node:fs';
     const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
     const t = createTracker(ws.workspace.tracker);
     await t.ensureMilestone({ title: 'Backlog', description: 'Triage later' });
     await t.ensureMilestone({ title: 'v0.1 — Alpha' });
     await t.ensureMilestone({ title: 'v1.0 — Launch' });
   "
   ```
   Skip if the user declines — milestones can be added anytime by calling `tracker.ensureMilestone(...)` or via the GitHub UI.

7. **Verify:**
   ```bash
   gh issue list --repo {slug} --limit 5
   ```
   Expected: empty list (no tickets yet) or the existing ones if the repo already had issues.

### Step 4: GitLab Issues configuration

1. **Verify `glab` auth.** Run `glab auth status`. For a self-managed instance, walk through `glab auth login --hostname {host}`. Do not proceed until authenticated.

2. **Resolve the target project.** Default to the workspace's own git remote (`git -C {workspace-root} remote get-url origin`, parsed as above). Ask: "Use `{group/sub/project}` for issues, or a different project?" Accept any nested `group/sub/project` path.

   GitLab projects have issues enabled by default, so there is no equivalent of the GitHub `hasIssuesEnabled` check.

3. **Write `workspace.json`:**
   ```json
   {
     "workspace": {
       "tracker": {
         "type": "gitlab-issues",
         "repo": "{group/sub/project}",
         "host": "{host}"
       }
     }
   }
   ```
   Include `"host"` only for a self-managed instance — omit it for gitlab.com. Preserve all other fields. Commit:
   ```bash
   git add workspace.json
   git commit -m "chore: configure gitlab-issues tracker on {group/sub/project}"
   ```

4. **Initialize labels and (optionally) milestones** exactly as in Step 3 — the one-liners go through `createTracker`, so the same commands work against GitLab.

5. **Verify:**
   ```bash
   glab issue list --repo {group/sub/project} --per-page 5
   ```

### Step 5: Configure epics (optional)

Epics group related issues across a release or theme. Two modes, both through the adapter:

- **Label mode** — the default, works on any plan, both backends. An epic is the label `epic:{name}` carried by every issue in it. Nothing to configure unless the team already uses that prefix for something else: `epicLabelPrefix` renames it (e.g. `"E:"` — any delimiter-terminated prefix works; a trailing alphanumeric is rejected), and existing labels under the chosen prefix become epics as they are. On GitLab, `epicLabelPrefix: "epic::"` makes epics **scoped labels** — GitLab itself then enforces one epic per issue.
- **Native mode** — GitLab only, `"epics": "native"`: real group epics with ids and URLs, living at the project's parent group. Needs Premium/Ultimate on that instance. Without it every epic call fails with a clear error pointing back at label mode — the adapter never silently falls back, so a native-configured team finds out at the first call instead of discovering epics split across two representations. GitHub has no native epic object: `"native"` on `github-issues` throws from every epic method (sub-issues may back one later).

Ask: "Group work into epics? [label/skip]" — plus `native` as a third choice when the backend is gitlab-issues. Default skip. For label or native, write the key into the `workspace.tracker` block (`{"epics": "label"}` or `{"epics": "native"}`; plain label mode needs no key at all). If the user wants starter epics, create them through the adapter — idempotent, so re-running setup duplicates nothing:

```bash
node --input-type=module -e "
  import { createTracker } from './.claude/scripts/trackers/interface.mjs';
  import { readFileSync } from 'node:fs';
  const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
  const t = createTracker(ws.workspace.tracker);
  await t.createEpic({ name: 'auth', description: 'Authentication work' });
  console.log((await t.listEpics()).map((e) => e.name).join(', '));
"
```

`/start-work` reads the epic list before creating a new issue and offers an epic picker once at least one epic exists; a workspace with none sees no change.

### Step 6: Report

```
Tracker configured:
  Type: {github-issues | gitlab-issues}
  Repo: {slug}
  Labels: bug, feat, chore, P1, P2, P3
  Epics: {label mode (epic:{name} labels) | native (GitLab group epics) | off}
  Milestones: {list or "(none — add via the forge UI)"}

Next: run /start-work to pick or create an issue and begin.
```

## Notes

- The workspace repo is the default target — no separate `workspace-{project}` repo needed.
- Issues track everything across all project repos in the workspace. Cross-repo work items live in one place.
- One-way integration: the tracker is the source of truth. Skills read and write via the adapter; nothing else reflects tracker state locally.
- If CLI auth later expires, skill flows will surface `gh`/`glab` errors — re-run `gh auth login` (or `glab auth login --hostname {host}`) and try again.
- Adding a new backend: write an adapter module at `.claude/scripts/trackers/{type}.mjs` implementing the interface in `interface.mjs`, then add a case in the `createTracker` switch statement.
