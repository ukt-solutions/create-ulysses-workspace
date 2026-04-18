// Tracker adapter interface. Skills import only from this module.
// See design-tracker-abstraction.md for the full Issue shape and method contracts.

import '../../lib/require-node.mjs';
import { createGithubAdapter } from './github-issues.mjs';

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
    default:
      throw new Error(`Unknown tracker type: ${config.type}`);
  }
}
