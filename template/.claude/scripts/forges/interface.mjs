// Forge adapter interface. Skills import only from this module.
//
// Where `trackers/` covers issue lifecycle (issues, comments, labels,
// milestones), `forges/` covers cross-cutting repo-host operations:
// pull requests, releases, and workflow runs. The two abstractions are
// intentionally separate — a workspace could in principle mix
// (e.g. `github-issues` tracker + `gitlab` forge), though the common
// case is forge = same host as tracker.
//
// Method contracts:
//
//   prCreate({ title, body, draft = false, base, head, repo? })
//     → { id, url, number }
//   prMerge({ id, strategy = 'merge', deleteBranch = false, repo? })
//     → { merged: true, url }
//     strategy: 'merge' | 'squash' | 'rebase'
//   prView({ id, repo?, json? })
//     → { id, url, state, mergeable, mergeStateStatus, reviewDecision, title }
//     json may name additional fields to pass through
//   releaseView({ tag, repo? })
//     → { tag, url, name, publishedAt }
//     throws ReleaseNotFound if the tag has no release
//   workflowRunFind({ workflow, branch, repo?, limit = 1 })
//     → { runId, status, conclusion, url } | null
//   workflowRunWatch({ runId, repo?, exitStatus = false })
//     → { exitCode }
//     exitStatus: when true, the underlying command exits non-zero on
//     workflow failure; the adapter still returns the exit code rather
//     than throwing — callers decide how to handle a failed run.
//
// `repo` defaults: each adapter resolves a default repo at construction
// time (e.g. from `workspace.forge.repo` or the local git origin remote);
// callers pass `repo` only when targeting a different one.
//
// All methods are async and may throw `ForgeError` subclasses on
// adapter-detectable failures. Raw spawn failures throw `Error`.

import '../../lib/require-node.mjs';
import { createGithubAdapter } from './github.mjs';
import { createGitlabAdapter } from './gitlab.mjs';

export class ForgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
  }
}

export class PrNotFound extends ForgeError {
  constructor(id) {
    super(`Pull request not found: ${id}`, 'PR_NOT_FOUND');
    this.name = 'PrNotFound';
    this.id = id;
  }
}

export class ReleaseNotFound extends ForgeError {
  constructor(tag) {
    super(`Release not found for tag: ${tag}`, 'RELEASE_NOT_FOUND');
    this.name = 'ReleaseNotFound';
    this.tag = tag;
  }
}

export class WorkflowNotFound extends ForgeError {
  constructor(query) {
    super(`Workflow run not found: ${JSON.stringify(query)}`, 'WORKFLOW_NOT_FOUND');
    this.name = 'WorkflowNotFound';
    this.query = query;
  }
}

export class MergeRejected extends ForgeError {
  constructor(id, reason) {
    super(`Merge rejected for ${id}: ${reason}`, 'MERGE_REJECTED');
    this.name = 'MergeRejected';
    this.id = id;
    this.reason = reason;
  }
}

// createForge takes the `workspace.forge` config block. If the block is
// absent (`undefined`/`null`), default to GitHub — this matches the
// migration story documented in `.claude/rules/forge-operations.md`:
// existing workspaces predate the field, so an unset value means
// "behave as you always have." A workspace that wants to opt out of
// forge operations entirely should set `workspace.forge: false`;
// callers passing `false` will get a no-op throw on every method.
export function createForge(config, options = {}) {
  if (config === false) {
    throw new ForgeError(
      'Forge operations disabled — set workspace.forge in workspace.json to enable.',
      'FORGE_DISABLED',
    );
  }
  const resolved = config ?? { type: 'github' };
  if (typeof resolved !== 'object') {
    throw new ForgeError(
      `Invalid workspace.forge config: expected object, got ${typeof resolved}`,
      'INVALID_CONFIG',
    );
  }
  const type = resolved.type ?? 'github';
  switch (type) {
    case 'github':
      return createGithubAdapter(resolved, options);
    case 'gitlab':
      return createGitlabAdapter(resolved, options);
    default:
      throw new ForgeError(`Unknown forge type: ${type}`, 'UNKNOWN_TYPE');
  }
}
