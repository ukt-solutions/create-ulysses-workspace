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

// Same remote shapes the forge adapters resolve a repo from: scp-style SSH
// (`git@github.com:owner/name.git`, `git@gitlab.com:group/sub/name.git`),
// scheme URLs (`ssh://git@host/...`, `https://host/...`, optional port), with
// or without a trailing `.git`. A URL that does not match is not
// forge-hosted, and the forge path supports forge-hosted repos only — a
// local/bare remote has no PR concept to aim at.
//
// GitLab repos may sit in nested groups (`group/sub/project` at any depth),
// so the parser returns the full `slug` plus `host` and `forge` type; GitHub
// remains exactly two segments (owner/name). `hosts` names additional
// self-managed GitLab hosts (workspace.forge.host) — gitlab.com is always
// recognised, and a URL on any other host parses as nothing.
function parseForgeRemote(url, { hosts = [] } = {}) {
  const parsed = parseRemoteUrl(url);
  if (!parsed) return null;
  const { host, path: segments } = parsed;
  if (segments.length < 2) return null;
  if (host === 'github.com') {
    if (segments.length !== 2) return null;
    return { owner: segments[0], name: segments[1], slug: segments.join('/'), host, forge: 'github' };
  }
  const gitlabHosts = new Set(['gitlab.com', ...hosts.map((h) => String(h).toLowerCase())]);
  if (gitlabHosts.has(host)) {
    return {
      owner: segments.slice(0, -1).join('/'),
      name: segments[segments.length - 1],
      slug: segments.join('/'),
      host,
      forge: 'gitlab',
    };
  }
  return null;
}

// Split any remote URL into host + path segments, or null when it is not a
// forge-shaped remote at all (local path, file:// URL, …).
function parseRemoteUrl(url) {
  const s = String(url).trim().replace(/\/+$/, '');
  // scp-style: user@host:path — the colon separator, no scheme.
  let m = s.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (m) return { host: m[1].toLowerCase(), path: splitRemotePath(m[2]) };
  // scheme://[user@]host[:port]/path
  m = s.match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/);
  if (m) return { host: m[1].toLowerCase(), path: splitRemotePath(m[2]) };
  return null;
}

function splitRemotePath(p) {
  return p.replace(/\.git$/, '').split('/').filter(Boolean);
}

// Self-managed GitLab hosts configured for this workspace — the value of
// workspace.forge.host, when set, is a GitLab host however the forge `type`
// reads (a mixed workspace may leave type unset entirely).
function forgeHosts(ws) {
  return [ws?.workspace?.forge?.host].filter(Boolean);
}

/**
 * Resolve how a task repo merges: "local" — nothing pushed, merged in the
 * repo's own source clone — when workspace.json asks for it
 * (repos.{repo}.merge, or workspace.merge for the workspace repo; the
 * right call for a clone whose origin is a third-party upstream nobody
 * here may push to) or when the repo has no origin remote at all;
 * "forge" — pushed and PR'd — when its origin parses as a forge-hosted
 * repo (github.com, gitlab.com, or the configured self-managed host). An
 * origin that is neither (say a local bare mirror with no override)
 * resolves to null: the caller stops with the override spelled out rather
 * than pushing somewhere that cannot host a PR.
 */
function mergeModeFor(root, repo, deps = {}) {
  const gitFn = deps.gitFn ?? spawnSync;
  const rootDir = resolve(root);
  const ws = readWorkspace(rootDir);
  const override = repo === WORKSPACE_REPO ? ws?.workspace?.merge : ws?.repos?.[repo]?.merge;
  if (override === 'local') return 'local';
  const res = gitFn('git', ['-C', repoDirFor(rootDir, repo), 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return 'local'; // no origin — nowhere to push
  return parseForgeRemote(String(res.stdout || '').trim(), { hosts: forgeHosts(ws) }) ? 'forge' : null;
}

export { WORKSPACE_REPO, repoDirFor, readWorkspace, parseForgeRemote, forgeHosts, mergeModeFor };
