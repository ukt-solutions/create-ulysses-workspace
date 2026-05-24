// GitHub forge adapter. Wraps the `gh` CLI via an injectable spawnFn so
// tests can mock without spawning a real subprocess (mirrors the pattern
// in trackers/github-issues.mjs).
//
// All operations target a single default `repo` resolved at construction
// time from `config.repo` (e.g. `"owner/name"`) or from the local git
// origin remote when `config.repo` is unset or `"auto"`. Per-call `repo`
// overrides allow targeting a different repo when needed.

import '../../lib/require-node.mjs';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  PrNotFound,
  ReleaseNotFound,
  WorkflowNotFound,
  MergeRejected,
} from './interface.mjs';

const PR_VIEW_FIELDS = 'number,url,state,title,mergeable,mergeStateStatus,reviewDecision,headRefName,baseRefName,isDraft,mergedAt';

export function createGithubAdapter(config, { spawnFn = nodeSpawnSync } = {}) {
  const defaultRepo = resolveRepo(config, spawnFn);

  function gh(args, { input } = {}) {
    const result = spawnFn('gh', args, {
      input,
      encoding: 'utf-8',
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
    });
    return result;
  }

  function ghOrThrow(args, opts) {
    const result = gh(args, opts);
    if (result.status !== 0) {
      throw new Error(`gh ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
    }
    return result.stdout || '';
  }

  function repoFor(override) {
    return override || defaultRepo;
  }

  async function prCreate({ title, body = '', draft = false, base, head, repo }) {
    if (!title) throw new Error('prCreate: title is required');
    const args = ['pr', 'create', '--repo', repoFor(repo), '--title', title, '--body-file', '-'];
    if (draft) args.push('--draft');
    if (base) args.push('--base', base);
    if (head) args.push('--head', head);
    const stdout = ghOrThrow(args, { input: body }).trim();
    // gh pr create prints the PR URL on success; sometimes preceded by warnings.
    const url = stdout.split('\n').filter(Boolean).pop();
    const m = url.match(/\/pull\/(\d+)/);
    if (!m) throw new Error(`Could not parse PR number from gh output: ${stdout}`);
    const number = parseInt(m[1], 10);
    return { id: `${repoFor(repo)}#${number}`, url, number };
  }

  async function prMerge({ id, strategy = 'merge', deleteBranch = false, repo }) {
    if (!id) throw new Error('prMerge: id is required');
    const { number, repo: parsedRepo } = parsePrId(id, repoFor(repo));
    const args = ['pr', 'merge', String(number), '--repo', parsedRepo];
    switch (strategy) {
      case 'merge': args.push('--merge'); break;
      case 'squash': args.push('--squash'); break;
      case 'rebase': args.push('--rebase'); break;
      default: throw new Error(`prMerge: unknown strategy: ${strategy}`);
    }
    if (deleteBranch) args.push('--delete-branch');
    const result = gh(args);
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      // Distinguish "not found" from "rejected" so callers can react.
      if (/not\s+found|could\s+not\s+resolve/i.test(stderr)) {
        throw new PrNotFound(id);
      }
      throw new MergeRejected(id, stderr || 'gh pr merge exited non-zero');
    }
    return { merged: true, url: `https://github.com/${parsedRepo}/pull/${number}` };
  }

  async function prView({ id, repo, json }) {
    if (!id) throw new Error('prView: id is required');
    const { number, repo: parsedRepo } = parsePrId(id, repoFor(repo));
    const fields = json || PR_VIEW_FIELDS;
    const result = gh(['pr', 'view', String(number), '--repo', parsedRepo, '--json', fields]);
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      if (/not\s+found|could\s+not\s+resolve/i.test(stderr)) {
        throw new PrNotFound(id);
      }
      throw new Error(`gh pr view failed: ${stderr}`);
    }
    const raw = JSON.parse(result.stdout);
    return {
      id,
      number: raw.number,
      url: raw.url,
      state: raw.state,
      title: raw.title,
      mergeable: raw.mergeable,
      mergeStateStatus: raw.mergeStateStatus,
      reviewDecision: raw.reviewDecision,
      headRefName: raw.headRefName,
      baseRefName: raw.baseRefName,
      isDraft: raw.isDraft,
      mergedAt: raw.mergedAt,
      _raw: raw,
    };
  }

  async function releaseView({ tag, repo }) {
    if (!tag) throw new Error('releaseView: tag is required');
    const target = repoFor(repo);
    const result = gh(['release', 'view', tag, '--repo', target, '--json', 'name,tagName,url,publishedAt,isDraft,isPrerelease']);
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      if (/release\s+not\s+found|not\s+found/i.test(stderr)) {
        throw new ReleaseNotFound(tag);
      }
      throw new Error(`gh release view failed: ${stderr}`);
    }
    const raw = JSON.parse(result.stdout);
    return {
      tag: raw.tagName,
      name: raw.name,
      url: raw.url,
      publishedAt: raw.publishedAt,
      isDraft: raw.isDraft,
      isPrerelease: raw.isPrerelease,
    };
  }

  async function workflowRunFind({ workflow, branch, repo, limit = 1 }) {
    if (!workflow) throw new Error('workflowRunFind: workflow is required');
    const target = repoFor(repo);
    const args = [
      'run', 'list',
      '--repo', target,
      '--workflow', workflow,
      '--limit', String(limit),
      '--json', 'databaseId,status,conclusion,url,headBranch,createdAt',
    ];
    if (branch) args.push('--branch', branch);
    const result = gh(args);
    if (result.status !== 0) {
      throw new Error(`gh run list failed: ${(result.stderr || '').trim()}`);
    }
    const runs = JSON.parse(result.stdout);
    if (runs.length === 0) return null;
    const first = runs[0];
    return {
      runId: String(first.databaseId),
      status: first.status,
      conclusion: first.conclusion,
      url: first.url,
      branch: first.headBranch,
      createdAt: first.createdAt,
    };
  }

  async function workflowRunWatch({ runId, repo, exitStatus = false }) {
    if (!runId) throw new Error('workflowRunWatch: runId is required');
    const target = repoFor(repo);
    const args = ['run', 'watch', String(runId), '--repo', target];
    if (exitStatus) args.push('--exit-status');
    const result = gh(args);
    if (result.status === 0) return { exitCode: 0 };
    // Distinguish "couldn't find" from "ran but failed".
    const stderr = (result.stderr || '').trim();
    if (/not\s+found|could\s+not\s+find/i.test(stderr)) {
      throw new WorkflowNotFound({ runId });
    }
    // `--exit-status` makes gh exit non-zero on workflow failure; surface
    // that without throwing so callers can record the failure URL.
    return { exitCode: result.status, stderr };
  }

  return {
    prCreate,
    prMerge,
    prView,
    releaseView,
    workflowRunFind,
    workflowRunWatch,
    get identity() { return `github:${defaultRepo}`; },
  };
}

// "owner/name#NUMBER" or just NUMBER (defaulting to the adapter's repo).
function parsePrId(id, fallbackRepo) {
  if (typeof id === 'number') return { number: id, repo: fallbackRepo };
  const m1 = String(id).match(/^(?<repo>[^#\s]+\/[^#\s]+)#(?<number>\d+)$/);
  if (m1) return { number: parseInt(m1.groups.number, 10), repo: m1.groups.repo };
  const m2 = String(id).match(/^#?(\d+)$/);
  if (m2) return { number: parseInt(m2[1], 10), repo: fallbackRepo };
  throw new Error(`Unparseable PR id: ${id}`);
}

function resolveRepo(config, spawnFn) {
  if (config?.repo && config.repo !== 'auto') return config.repo;
  const result = spawnFn('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git remote get-url failed: ${(result.stderr || '').trim()}`);
  }
  const m = result.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot parse GitHub remote: ${result.stdout.trim()}`);
  return `${m[1]}/${m[2]}`;
}
