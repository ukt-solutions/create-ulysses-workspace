// GitLab forge adapter — stub. Reserved as the next sibling of github.mjs
// so the discovery pattern stays uniform: workspaces opting into GitLab
// set `workspace.forge.type: gitlab` in workspace.json and get a clear
// "not implemented" error pointing at the gap, rather than silently
// routing through GitHub.
//
// When implemented, this adapter wraps the `glab` CLI the same way
// github.mjs wraps `gh`: same method surface (prCreate, prMerge, prView,
// releaseView, workflowRunFind, workflowRunWatch), same spawnFn-injectable
// shape for testability, same error types from interface.mjs.

import { ForgeError } from './interface.mjs';

export function createGitlabAdapter(config /* , options */) {
  throw new ForgeError(
    'GitLab forge adapter is not implemented yet. Set workspace.forge.type to "github", or contribute a glab-based adapter at .claude/scripts/forges/gitlab.mjs following the shape of github.mjs.',
    'NOT_IMPLEMENTED',
  );
}
