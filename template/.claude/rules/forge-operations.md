Activate this rule if the workspace creates PRs, watches CI runs, or interacts with releases from skills. Sibling to `work-item-tracking.md` (which covers issues); together they cover everything a workspace needs to do against a code-hosting forge.

# Forge Operations

When a workspace has a forge configured, all pull-request, release, and workflow-run operations from skills and scripts go through the adapter at `.claude/scripts/forges/{type}.mjs`. Skills never call `gh` (or `glab`, or any forge CLI) inline.

## Why the abstraction

- **Swap by config.** Moving from GitHub to GitLab is a `workspace.json` field change plus an adapter file — not a sweep across six skill files.
- **Testable.** The adapter takes an injectable `spawnFn`; unit tests mock subprocess calls instead of running them.
- **One vocabulary.** Skills reason about `forge.prCreate`, `forge.prMerge`, `forge.workflowRunFind`, `forge.workflowRunWatch`, `forge.releaseView` regardless of backend. Failure modes share typed errors (`PrNotFound`, `MergeRejected`, `WorkflowNotFound`, `ReleaseNotFound`) instead of every callsite parsing stderr.

## Configuration

`workspace.json` → `workspace.forge`:

```json
{
  "workspace": {
    "forge": {
      "type": "github"
    }
  }
}
```

- `type` — identifies the adapter module at `.claude/scripts/forges/{type}.mjs`. `github` is the default and the only fully-implemented adapter today. `gitlab.mjs` ships as a stub that throws `NOT_IMPLEMENTED` with a contribution pointer.
- `repo` (optional) — adapter-specific. For `github`, the `owner/name` slug to target. When unset or `"auto"`, the adapter resolves the repo from the local git `origin` remote.

Absence of `workspace.forge` is treated as `{ type: 'github' }` (back-compat for workspaces that predate the field). Setting `workspace.forge: false` explicitly disables forge operations — every adapter method then throws `FORGE_DISABLED`.

## Adapter interface (for Claude)

Import from `.claude/scripts/forges/interface.mjs`:

```javascript
import { createForge, PrNotFound, MergeRejected, WorkflowNotFound, ReleaseNotFound } from '.claude/scripts/forges/interface.mjs';
import { readFileSync } from 'node:fs';

const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
const forge = createForge(ws.workspace?.forge);

// Pull request lifecycle
const pr = await forge.prCreate({
  title: 'feat: add forge adapter',
  body: 'long-form body',
  draft: false,                // omit or false for normal PRs; true for /pause-work drafts
  base: 'main',                // optional; defaults to repo default branch
  head: 'feature/forge',       // optional; defaults to current branch
});                            // → { id: 'owner/repo#42', url, number }

await forge.prMerge({
  id: pr.id,
  strategy: 'squash',          // 'merge' | 'squash' | 'rebase'
  deleteBranch: true,
});

const view = await forge.prView({ id: pr.id });
// → { state, mergeable, mergeStateStatus, reviewDecision, ... }

// Releases (lookup only — release creation lives in the workflow tag-push)
const release = await forge.releaseView({ tag: 'v1.2.3' });
// → { tag, name, url, publishedAt, isDraft, isPrerelease }
// throws ReleaseNotFound if the tag has no release

// Workflow runs (used by /complete-work to follow the publish workflow)
const run = await forge.workflowRunFind({
  workflow: 'publish.yml',
  branch: 'v1.2.3',
  limit: 1,
});                            // → { runId, status, conclusion, url } | null
const result = await forge.workflowRunWatch({
  runId: run.runId,
  exitStatus: true,            // true: exit non-zero on workflow failure
});                            // → { exitCode } — does NOT throw on workflow failure
```

All methods are async. Adapter-detectable failures throw typed errors; raw spawn failures throw `Error`.

## Skill behavior

Skills that interact with forge operations:

- **`/pause-work`** — creates draft PRs via `forge.prCreate({ draft: true })`.
- **`/complete-work`** — creates PRs, merges them with `strategy: 'squash'`, and (release sessions only) finds + watches the publish workflow via `workflowRunFind` + `workflowRunWatch`. Uses `releaseView` to investigate existing tag conflicts before re-tagging.

Skills outside that list do not call the forge adapter; they either don't touch the forge or they touch it for tracker-setup-specific operations that are deliberately scoped out (see below).

## What this rule does NOT cover

- **Issue lifecycle.** Issues, comments, labels, milestones live in `work-item-tracking.md` via the tracker adapter at `.claude/scripts/trackers/{type}.mjs`. The two abstractions are intentionally separate.
- **Tracker-setup repo configuration.** `/setup-tracker` uses `gh repo view --json hasIssuesEnabled` and `gh api repos/{slug} -X PATCH -f has_issues=true` to inspect and enable the Issues feature on a GitHub repo. Those are GitHub-API-specific setup operations, not the cross-cutting PR/release ops the forge abstraction targets. A GitLab user running `/setup-tracker` would follow a different setup flow entirely, so wrapping these in the forge adapter would create a leaky abstraction. They remain direct `gh` calls.
- **`gh repo view` as a remote-type probe.** `/complete-work` uses `gh repo view` to detect whether a remote is a GitHub remote (separately from any PR operation that follows). This is a one-line capability check, not an operation that benefits from forge wrapping. It stays direct.
- **Repo creation.** `gh repo create` (in `/sync-work` and `/workspace-init` setup narratives) is an interactive one-off used when a workspace lacks a remote. No forge adapter method for it — pointing users at a wrapped form when none exists would be worse than the current direct mention.
- **Manual operator recovery.** `gh run rerun`, `gh run view`, `gh release view` referenced in `/release` recovery guidance are documented for an operator at a terminal investigating a failed publish. The forge adapter is for *skill code*, not the manual recovery prose.

## Migration

Existing workspaces predate `workspace.forge`. They continue to work because `createForge(undefined)` defaults to `{ type: 'github' }`. The `/maintenance` audit surfaces a notice when `workspace.tracker.type === 'github-issues'` and `workspace.forge` is unset, suggesting the explicit value — a one-line `workspace.json` addition with no behavior change.

A workspace switching to GitLab implements `.claude/scripts/forges/gitlab.mjs` against the interface (the stub file documents the shape) and sets `workspace.forge.type: 'gitlab'`. No skill rewrite is required; the abstraction does the routing.

## What this rule does NOT do

- Does not prescribe a specific forge type. Adapter choice is per workspace.
- Does not replace forge-native features (PR comments, review-requested webhooks, branch protection settings) — those remain UI / direct-CLI territory.
- Does not promise that every `gh` capability is wrapped. The adapter covers the operations the template's skills actually perform. New operations land via additive interface methods, not by skills going around the adapter.
