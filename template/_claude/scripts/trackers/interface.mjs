// Tracker adapter interface. Skills import only from this module.
// See design-tracker-abstraction.md for the full Issue shape and method contracts.
//
// Method contract added alongside task-pr.mjs (gh:163):
//
//   issueRef(issueId, { fromRepo })
//     → the closing reference for a PR body: "#N" when fromRepo is (or
//       defaults to) this adapter's own repo, "owner/repo#N" otherwise —
//       only the first form closes an issue in the PR's own repo, so a PR
//       in any other repo must name the tracker's repo explicitly.
//
// Epic method contract (gh:195) — every adapter implements all five:
//
//   listEpics({ state } = { state: 'open' }) → Epic[] — { name, id?,
//     native, url?, state? }. `id`, `state` and `groupId` only exist in
//     native mode; a closed GitLab epic is filtered out unless state is
//     "all". Label mode has no epic state and ignores the option.
//   getEpic(name) → the Epic, or null when absent. Names match
//     case-insensitively — both forges treat labels that way — and the
//     returned name is the label's own casing.
//   createEpic({ name, description? }) → the Epic, creating only when no
//     epic of that name exists in any casing (idempotent) — epics are
//     created deliberately, never as a side effect of assigning an issue.
//   setIssueEpic(issueId, name | null)
//     An issue carries exactly one epic: assigning replaces any current
//     epic, null removes it. An unknown name throws — a typo must never
//     mint an epic.
//   listEpicIssues(name, { state }) → Issue[], state "open" | "closed" |
//     "all" (default open; anything else throws).
//
// Modes: label mode (default, both adapters) represents an epic as the
// label `epicLabelPrefix + name` — default prefix "epic:", configurable
// via workspace.tracker.epicLabelPrefix, which must end with a delimiter
// (resolveEpicLabelPrefix enforces that) — carried by every issue in the
// epic. Native mode (GitLab only, workspace.tracker.epics: "native") uses
// group epics and needs Premium/Ultimate; without it the group-epic
// endpoints answer 403/404, which must surface as a clear error pointing
// at label mode — never a silent fallback, or epics would silently live
// in two places. Epic iids are unique only within their group, so native
// epics are pinned to the tracker group's own (descendant and ancestor
// groups excluded) and matched by group and iid together. GitHub has no
// native epic object: `epics: "native"` throws from every epic method
// there (sub-issues may back one later).

import '../../lib/require-node.mjs';
import { createGithubAdapter } from './github-issues.mjs';
import { createGitlabAdapter } from './gitlab-issues.mjs';

export class AlreadyAssignedError extends Error {
  constructor(issueId, assignees) {
    super(`${issueId} is already assigned to ${assignees.join(', ')}`);
    this.name = 'AlreadyAssignedError';
    this.code = 'ALREADY_ASSIGNED';
    this.assignees = assignees;
  }
}

// Shared epic-label-prefix resolution (gh:195): `epicLabelPrefix` from the
// tracker config, defaulting to "epic:". A prefix must end with a delimiter
// (":", "-", "/") — a trailing alphanumeric would slice epic names at an
// arbitrary character and make label↔name mapping ambiguous.
export function resolveEpicLabelPrefix(config) {
  const prefix = typeof config?.epicLabelPrefix === 'string' && config.epicLabelPrefix
    ? config.epicLabelPrefix
    : 'epic:';
  if (/[a-z0-9]$/i.test(prefix)) {
    throw new Error(`tracker.epicLabelPrefix "${prefix}" must end with a delimiter such as ":" or "-"`);
  }
  return prefix;
}

export function createTracker(config, options = {}) {
  if (!config || typeof config !== 'object') {
    throw new Error('No tracker configured — pass workspace.json\'s workspace.tracker block.');
  }
  switch (config.type) {
    case 'github-issues':
      return createGithubAdapter(config, options);
    case 'gitlab-issues':
      return createGitlabAdapter(config, options);
    default:
      throw new Error(`Unknown tracker type: ${config.type}`);
  }
}
