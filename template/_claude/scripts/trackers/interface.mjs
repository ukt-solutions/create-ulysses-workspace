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
//   listEpics() → Epic[] — { name, id?, native, url? }. `id` is the forge's
//     own epic identifier and only exists in native mode.
//   getEpic(name) → the Epic, or null when absent.
//   createEpic({ name, description? }) → the Epic, creating only when the
//     name is new (idempotent) — epics are created deliberately, never as
//     a side effect of assigning an issue.
//   setIssueEpic(issueId, name | null)
//     An issue carries exactly one epic: assigning replaces any current
//     epic, null removes it. An unknown name throws — a typo must never
//     mint an epic.
//   listEpicIssues(name, { state }) → Issue[], state "open" | "closed" |
//     "all" (default open).
//
// Modes: label mode (default, both adapters) represents an epic as the
// label `epicLabelPrefix + name` — default prefix "epic:", configurable
// via workspace.tracker.epicLabelPrefix — carried by every issue in the
// epic. Native mode (GitLab only, workspace.tracker.epics: "native") uses
// group epics and needs Premium/Ultimate; without it the group-epic
// endpoints answer 403/404, which must surface as a clear error pointing
// at label mode — never a silent fallback, or epics would silently live in
// two places. GitHub has no native epic object: `epics: "native"` throws
// from every epic method there (sub-issues may back one later).

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
