---
paths:
  - "**/.claude/skills/**"
  - "**/.claude/scripts/**"
---

Activate this rule if the workspace creates PRs, watches CI runs, or interacts with releases from skills. Sibling to `work-item-tracking.md` (which covers issues); together they cover everything a workspace does against a code-hosting forge.

# Forge Operations

**Skills never call `gh` (or `glab`, or any forge CLI) inline for pull-request, release, or
workflow-run operations.** They go through the adapter at `.claude/scripts/forges/{type}.mjs`,
reached via `createForge()` from `.claude/scripts/forges/interface.mjs`.

The interface module is the source of truth for the available methods and their shapes —
read it when you need the API. `/complete-work` and `/pause-work` each carry the exact calls
they make, so in practice you rarely need to look.

## Why

Switching code hosts becomes a `workspace.json` field plus one adapter file instead of a
sweep across six skills. Failure modes share typed errors — `PrNotFound`, `MergeRejected`,
`WorkflowNotFound`, `ReleaseNotFound` — instead of every callsite parsing stderr. And the
adapter takes an injectable `spawnFn`, so tests mock subprocesses rather than running them.

## Configuration

`workspace.json` → `workspace.forge`: `{ "type": "github" | "gitlab" }`. `type` names the adapter
module — `github.mjs` wraps `gh`, `gitlab.mjs` wraps `glab`; both implement the same method
surface. With no `type`, the adapter is picked from the target repo's host: gitlab.com (or the
configured `host`) selects GitLab, anything else stays GitHub — which is how one workspace can
mix GitHub and GitLab repos, each origin naming its own forge. Optional `repo` is the project
slug (`owner/name` on GitHub, `group/sub/project` at any depth on GitLab); unset or `"auto"`
resolves from the git `origin` remote. A self-managed GitLab sets `host` (glab receives it as
`GITLAB_HOST`). An absent `workspace.forge` is treated as `{ type: 'github' }`; setting it to
`false` makes every adapter method throw `FORGE_DISABLED`.

GitLab gaps, by design: `releaseCreate` with `generateNotes: true` throws `NOT_SUPPORTED` —
GitLab cannot generate notes from merged MRs, so callers pass explicit `notes` with
`generateNotes: false`. Workflow runs map onto pipelines: `workflowRunFind` ignores the workflow
name (one pipeline per ref) and `workflowRunWatch` polls instead of streaming. `reviewDecision`
is always empty — approvals surface through `mergeStateStatus`.

## Deliberate exceptions — do not "fix" these

These stay as direct `gh` calls. Wrapping them would create a leaky abstraction, so leave them
alone:

- **Issue lifecycle** — issues, comments, labels and milestones belong to the tracker adapter.
  See `work-item-tracking.md`. The two abstractions are intentionally separate.
- **`/setup-tracker` repo configuration** — `gh repo view --json hasIssuesEnabled` and
  `gh api repos/{slug} -X PATCH -f has_issues=true` are GitHub-API-specific setup, not
  cross-cutting operations. GitLab projects have issues on by default, so its setup flow
  needs no equivalent check.
- **`gh repo view` as a remote-type probe** — a one-line capability check, not an operation.
- **`gh repo create`** — an interactive one-off when a workspace has no remote.
- **Manual recovery prose** — `gh run rerun`, `gh run view`, `gh release view` in `/release`
  guidance are for an operator at a terminal, not for skill code.

## Boundaries

The adapter covers the operations the template's skills actually perform, not every `gh`
capability. New operations land as additive interface methods, never by a skill going around
the adapter. Forge-native features — PR comments, review webhooks, branch protection — remain
UI and direct-CLI territory.

Workspaces predating `workspace.forge` keep working, since `createForge(undefined)` defaults to
GitHub. `/maintenance` surfaces a notice suggesting the explicit value.
