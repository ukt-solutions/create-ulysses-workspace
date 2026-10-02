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
