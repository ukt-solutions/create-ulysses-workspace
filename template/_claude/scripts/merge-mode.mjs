// Merge-mode resolution for the task lifecycle (gh:173), shared by
// task-worktree.mjs (which branch a new task worktree starts from) and
// task-pr.mjs (push-and-PR versus merge-in-the-source-clone). It lives in
// its own module because those two import each other's helpers: housing
// the rule here keeps its definition singular without a circular import.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// The workspace repo (the launcher) is addressed as "." — the one repo
// name that is not a directory under repos/.
const WORKSPACE_REPO = '.';

// "." is the workspace repo itself — the git repo at the root. Every other
// name is a directory under repos/.
function repoDirFor(rootDir, repo) {
  return repo === WORKSPACE_REPO ? rootDir : join(rootDir, 'repos', repo);
}

function readWorkspace(rootDir) {
  try {
    return JSON.parse(readFileSync(join(rootDir, 'workspace.json'), 'utf-8'));
  } catch {
    throw new Error(`cannot read ${join(rootDir, 'workspace.json')} — is --root the launcher?`);
  }
}

// Same remote shapes the forge adapters resolve a repo from. A URL that
// does not match is not forge-hosted, and the forge path supports
// forge-hosted repos only — a local/bare remote has no PR concept to aim at.
const FORGE_REMOTE_RE = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/;

function parseForgeRemote(url) {
  const m = String(url).trim().match(FORGE_REMOTE_RE);
  return m ? { owner: m[1], name: m[2] } : null;
}

/**
 * Resolve how a task repo merges: "local" — nothing pushed, merged in the
 * repo's own source clone — when workspace.json asks for it
 * (repos.{repo}.merge, or workspace.merge for the workspace repo; the
 * right call for a clone whose origin is a third-party upstream nobody
 * here may push to) or when the repo has no origin remote at all;
 * "forge" — pushed and PR'd — when its origin parses as a forge-hosted
 * owner/name. An origin that is neither (say a local bare mirror with no
 * override) resolves to null: the caller stops with the override spelled
 * out rather than pushing somewhere that cannot host a PR.
 */
function mergeModeFor(root, repo, deps = {}) {
  const gitFn = deps.gitFn ?? spawnSync;
  const rootDir = resolve(root);
  const ws = readWorkspace(rootDir);
  const override = repo === WORKSPACE_REPO ? ws?.workspace?.merge : ws?.repos?.[repo]?.merge;
  if (override === 'local') return 'local';
  const res = gitFn('git', ['-C', repoDirFor(rootDir, repo), 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return 'local'; // no origin — nowhere to push
  return parseForgeRemote(String(res.stdout || '').trim()) ? 'forge' : null;
}

export { WORKSPACE_REPO, repoDirFor, readWorkspace, parseForgeRemote, mergeModeFor };
