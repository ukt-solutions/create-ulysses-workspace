// GitHub Issues adapter. Wraps the `gh` CLI via an injectable spawnFn.
// Issue IDs are opaque strings of the form "gh:N" — adapters outside this file
// don't need to parse them; routing is handled by interface.mjs.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { AlreadyAssignedError } from './interface.mjs';

const ISSUE_FIELDS = 'number,title,body,state,assignees,labels,milestone,url,createdAt,updatedAt';

const STANDARD_LABELS = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'feat', color: 'a2eeef' },
  { name: 'chore', color: 'cfd3d7' },
  { name: 'P1', color: 'b60205' },
  { name: 'P2', color: 'fbca04' },
  { name: 'P3', color: '0e8a16' },
];

export function createGithubAdapter(config, { spawnFn = nodeSpawnSync } = {}) {
  const repo = resolveRepo(config, spawnFn);
  let loginCache = null;

  function gh(args, { input } = {}) {
    const result = spawnFn('gh', args, {
      input,
      encoding: 'utf-8',
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      throw new Error(`gh ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
    }
    return result.stdout || '';
  }

  function getLogin() {
    if (loginCache) return loginCache;
    loginCache = gh(['api', 'user', '--jq', '.login']).trim();
    return loginCache;
  }

  function normalize(raw) {
    return {
      id: `gh:${raw.number}`,
      number: raw.number,
      title: raw.title,
      body: raw.body || '',
      state: (raw.state || '').toLowerCase() === 'closed' ? 'closed' : 'open',
      assignees: (raw.assignees || []).map(a => a.login),
      labels: (raw.labels || []).map(l => l.name),
      milestone: raw.milestone?.title ?? null,
      url: raw.url,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  function parseIssueNumber(issueId) {
    const m = issueId.match(/^gh:(\d+)$/);
    if (!m) throw new Error(`Not a GitHub issue ID: ${issueId}`);
    return parseInt(m[1], 10);
  }

  async function listAssignedToMe() {
    const me = getLogin();
    const stdout = gh(['issue', 'list', '--repo', repo, '--assignee', me, '--state', 'open', '--json', ISSUE_FIELDS]);
    return JSON.parse(stdout).map(normalize);
  }

  async function listUnassigned() {
    const stdout = gh(['issue', 'list', '--repo', repo, '--search', 'no:assignee', '--state', 'open', '--json', ISSUE_FIELDS]);
    return JSON.parse(stdout).map(normalize);
  }

  async function getIssue(issueId) {
    const num = parseIssueNumber(issueId);
    const stdout = gh(['issue', 'view', String(num), '--repo', repo, '--json', ISSUE_FIELDS]);
    return normalize(JSON.parse(stdout));
  }

  async function claim(issueId) {
    const me = getLogin();
    const issue = await getIssue(issueId);
    const others = issue.assignees.filter(a => a !== me);
    if (others.length > 0) {
      throw new AlreadyAssignedError(issueId, others);
    }
    if (!issue.assignees.includes(me)) {
      gh(['issue', 'edit', String(issue.number), '--repo', repo, '--add-assignee', me]);
      return getIssue(issueId);
    }
    return issue;
  }

  async function createIssue({ title, body = '', labels = [], milestone = null }) {
    const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'];
    if (labels.length > 0) args.push('--label', labels.join(','));
    if (milestone) args.push('--milestone', milestone);
    const stdout = gh(args, { input: body });
    const m = stdout.match(/\/issues\/(\d+)/);
    if (!m) throw new Error(`Could not parse issue number from: ${stdout.trim()}`);
    return getIssue(`gh:${m[1]}`);
  }

  async function comment(issueId, body) {
    const num = parseIssueNumber(issueId);
    gh(['issue', 'comment', String(num), '--repo', repo, '--body-file', '-'], { input: body });
  }

  async function closeIssue(issueId, { comment: commentBody } = {}) {
    const num = parseIssueNumber(issueId);
    if (commentBody) {
      gh(['issue', 'comment', String(num), '--repo', repo, '--body-file', '-'], { input: commentBody });
    }
    gh(['issue', 'close', String(num), '--repo', repo]);
  }

  async function ensureLabels() {
    for (const { name, color } of STANDARD_LABELS) {
      gh(['label', 'create', name, '--repo', repo, '--color', color, '--force']);
    }
  }

  return {
    listAssignedToMe,
    listUnassigned,
    getIssue,
    claim,
    createIssue,
    comment,
    closeIssue,
    ensureLabels,
    get identity() { return `github-issues:${repo}`; },
  };
}

function resolveRepo(config, spawnFn) {
  if (config.repo && config.repo !== 'auto') return config.repo;
  const result = spawnFn('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git remote get-url failed: ${(result.stderr || '').trim()}`);
  }
  const m = result.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot parse GitHub remote: ${result.stdout.trim()}`);
  return `${m[1]}/${m[2]}`;
}
