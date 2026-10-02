// GitLab Issues adapter. Wraps the `glab` CLI via an injectable spawnFn
// (mirrors trackers/github-issues.mjs). Issue IDs are opaque strings of the
// form "gl:N" — adapters outside this file don't need to parse them;
// routing is handled by interface.mjs.
//
// The repo is a `group/sub/project` path (any depth); a self-managed
// instance is selected with `host` in the tracker config (GITLAB_HOST for
// glab, --hostname for `glab api`), defaulting to gitlab.com.

import '../../lib/require-node.mjs';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { AlreadyAssignedError } from './interface.mjs';

const GITLAB_DEFAULT_HOST = 'gitlab.com';

const STANDARD_LABELS = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'feat', color: 'a2eeef' },
  { name: 'chore', color: 'cfd3d7' },
  { name: 'P1', color: 'b60205' },
  { name: 'P2', color: 'fbca04' },
  { name: 'P3', color: '0e8a16' },
];

export function createGitlabAdapter(config, { spawnFn = nodeSpawnSync } = {}) {
  const repo = resolveRepo(config, spawnFn);
  const host = typeof config?.host === 'string' && config.host ? config.host : GITLAB_DEFAULT_HOST;
  let loginCache = null;

  function glab(args, { input } = {}) {
    // GITLAB_HOST always names the resolved instance — always, because an
    // exported foreign value must not leak into a gitlab.com run — and
    // aims the -R/--repo slugs at it.
    const env = { ...process.env, GITLAB_HOST: host };
    const result = spawnFn('glab', args, {
      input,
      encoding: 'utf-8',
      env,
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      throw new Error(`glab ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
    }
    return result.stdout || '';
  }

  // `glab api` resolves its host from the CWD's git remote, not from
  // GITLAB_HOST, so the resolved host is always passed explicitly.
  function apiArgs(path) {
    return ['api', path, '--hostname', host];
  }

  // Paged walk over a `glab api` list endpoint — 100 at a time until a
  // short page. The list subcommands fetch a single page and cannot
  // express the server-side filters some of these calls need, so `glab
  // api` does both jobs.
  function apiListAll(path, params = []) {
    const found = [];
    for (let page = 1; ; page += 1) {
      const query = [...params, 'per_page=100', `page=${page}`].join('&');
      const batch = JSON.parse(glab(apiArgs(`${path}?${query}`)));
      if (!Array.isArray(batch)) {
        throw new Error(`glab api ${path} returned a non-list: ${JSON.stringify(batch).slice(0, 80)}`);
      }
      found.push(...batch);
      if (batch.length < 100) break;
    }
    return found;
  }

  function currentUser() {
    if (loginCache) return loginCache;
    loginCache = JSON.parse(glab(apiArgs('user'))).username;
    return loginCache;
  }

  function normalize(raw) {
    return {
      id: `gl:${raw.iid}`,
      number: raw.iid,
      title: raw.title,
      body: raw.description || '',
      state: (raw.state || '').toLowerCase() === 'closed' ? 'closed' : 'open',
      assignees: (raw.assignees || []).map((a) => a.username),
      labels: (raw.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      milestone: raw.milestone?.title ?? null,
      url: raw.web_url,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  function parseIssueNumber(issueId) {
    const m = issueId.match(/^gl:(\d+)$/);
    if (!m) throw new Error(`Not a GitLab issue ID: ${issueId}`);
    return parseInt(m[1], 10);
  }

  async function listAssignedToMe() {
    const me = currentUser();
    // `glab issue list` defaults to open issues; JSON output is -O here,
    // -F on the single-entity commands.
    const stdout = glab(['issue', 'list', '--repo', repo, '--assignee', me, '-O', 'json', '--per-page', '100']);
    return JSON.parse(stdout).map(normalize);
  }

  async function listUnassigned() {
    // The API's server-side `assignee_id=None` filter, paged to the end —
    // a client-side filter over one `issue list` page saw only the first
    // hundred open issues.
    return apiListAll(`projects/${encodeURIComponent(repo)}/issues`, ['state=opened', 'assignee_id=None'])
      .map(normalize);
  }

  async function getIssue(issueId) {
    const num = parseIssueNumber(issueId);
    const stdout = glab(['issue', 'view', String(num), '--repo', repo, '-F', 'json']);
    return normalize(JSON.parse(stdout));
  }

  async function claim(issueId) {
    const me = currentUser();
    const issue = await getIssue(issueId);
    const others = issue.assignees.filter((a) => a !== me);
    if (others.length > 0) {
      throw new AlreadyAssignedError(issueId, others);
    }
    if (!issue.assignees.includes(me)) {
      // --assignee replaces the assignee list; with no other assignees
      // (checked above) that is exactly "assign me".
      glab(['issue', 'update', String(issue.number), '--repo', repo, '--assignee', me]);
      return getIssue(issueId);
    }
    return issue;
  }

  async function createIssue({ title, body = '', labels = [], milestone = null }) {
    const args = ['issue', 'create', '--repo', repo, '--title', title, '--description', body, '--yes'];
    if (labels.length > 0) args.push('--label', labels.join(','));
    if (milestone) args.push('--milestone', milestone);
    const stdout = glab(args);
    const m = stdout.match(/\/-\/issues\/(\d+)/);
    if (!m) throw new Error(`Could not parse issue number from: ${stdout.trim()}`);
    return getIssue(`gl:${m[1]}`);
  }

  async function comment(issueId, body) {
    const num = parseIssueNumber(issueId);
    // glab has no --body-file: the message travels as an argv element.
    glab(['issue', 'note', String(num), '--repo', repo, '--message', body]);
  }

  // A closing reference for MR bodies: `#N` closes an issue in the MR's own
  // project, `group/sub/project#N` reaches one living elsewhere — the same
  // shapes github-issues renders, with GitLab's full-path reference for the
  // cross-project case. No `fromRepo` means the MR is in this adapter's own
  // project.
  function issueRef(issueId, { fromRepo } = {}) {
    const num = parseIssueNumber(issueId);
    return fromRepo && fromRepo !== repo ? `${repo}#${num}` : `#${num}`;
  }

  // The canonical URL for an issue — what a cross-forge reference needs
  // (a `group/sub#N` reference cannot resolve on a GitHub PR), minted from
  // the same host/repo every other URL here is built from.
  function issueUrl(issueId) {
    const num = parseIssueNumber(issueId);
    return `https://${host}/${repo}/-/issues/${num}`;
  }

  async function closeIssue(issueId, { comment: commentBody } = {}) {
    const num = parseIssueNumber(issueId);
    if (commentBody) {
      glab(['issue', 'note', String(num), '--repo', repo, '--message', commentBody]);
    }
    glab(['issue', 'close', String(num), '--repo', repo]);
  }

  async function ensureLabels() {
    // No --force equivalent: labels that exist are left as they are, so
    // this stays idempotent without rewriting a team's chosen colors.
    const stdout = glab(['label', 'list', '--repo', repo, '-F', 'json', '--per-page', '100']);
    const existing = new Set(JSON.parse(stdout).map((l) => l.name));
    for (const { name, color } of STANDARD_LABELS) {
      if (existing.has(name)) continue;
      glab(['label', 'create', '--repo', repo, '--name', name, '--color', `#${color}`]);
    }
  }

  // `glab milestone create` prints human text (it has no JSON output flag),
  // and `milestone list` fetches a single page — so listing goes through
  // the API paged to the end, and a create is verified by re-listing
  // rather than by parsing what glab printed.
  async function ensureMilestone({ title, description = '', dueOn = null } = {}) {
    if (!title) throw new Error('ensureMilestone: title is required');
    const findByTitle = () => apiListAll(`projects/${encodeURIComponent(repo)}/milestones`)
      .find((m) => m.title === title);
    const existing = findByTitle();
    if (existing) return normalizeMilestone(existing);
    const args = ['milestone', 'create', '--repo', repo, '--title', title];
    if (description) args.push('--description', description);
    if (dueOn) args.push('--due-date', dueOn);
    glab(args);
    const created = findByTitle();
    if (!created) {
      throw new Error(`milestone "${title}" was not in the milestone list after glab milestone create`);
    }
    return normalizeMilestone(created);
  }

  return {
    listAssignedToMe,
    listUnassigned,
    getIssue,
    claim,
    createIssue,
    comment,
    closeIssue,
    issueRef,
    issueUrl,
    ensureLabels,
    ensureMilestone,
    get identity() { return `gitlab-issues:${repo}`; },
  };
}

function normalizeMilestone(raw) {
  return {
    number: raw.id,
    title: raw.title,
    description: raw.description || '',
    state: raw.state === 'closed' ? 'closed' : 'open', // GitLab says "active"
    dueOn: raw.due_date || null,
    url: raw.web_url,
  };
}

// Like github-issues.mjs's resolveRepo, kept local so the adapter stands
// alone: gitlab.com plus the configured self-managed host, scp-style and
// scheme URLs (an explicit non-default port stays in the host, so `host`
// can carry it — gitlab.example.com:8443), nested groups at any depth,
// optional .git suffix.
const DEFAULT_PORTS = { https: 443, http: 80, ssh: 22, git: 9418 };
const SCHEME_URL_RE = /^(?<scheme>https?|ssh|git):\/\/(?:[^@/]+@)?(?<host>[^:/]+)(?::(?<port>\d+))?\/(?<path>.+)$/;

function resolveRepo(config, spawnFn) {
  if (config?.repo && config.repo !== 'auto') return config.repo;
  const result = spawnFn('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git remote get-url failed: ${(result.stderr || '').trim()}`);
  }
  const hosts = [GITLAB_DEFAULT_HOST, ...(config?.host ? [String(config.host).toLowerCase()] : [])];
  const s = result.stdout.trim().replace(/\/+$/, '');
  let host = null;
  let path = null;
  const scp = s.match(/^[^@/]+@([^:/]+):(.+)$/); // scp-style: git@host:path
  if (scp) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    const m = s.match(SCHEME_URL_RE);
    if (m) {
      const { scheme, host: h, port } = m.groups;
      // A non-default port stays part of the host so it can match a
      // configured host that carries one; a default port drops, so
      // github.com:443-style URLs still resolve.
      host = (port && Number(port) !== DEFAULT_PORTS[scheme] ? `${h}:${port}` : h).toLowerCase();
      path = m.groups.path;
    }
  }
  if (host && path && hosts.includes(host)) {
    const segments = path.replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length >= 2) return segments.join('/');
  }
  throw new Error(`Cannot parse GitLab remote: ${result.stdout.trim()}`);
}
