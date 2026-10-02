// GitLab forge adapter. Wraps the `glab` CLI via an injectable spawnFn so
// tests can mock without spawning a real subprocess (mirrors the pattern
// in github.mjs / trackers/github-issues.mjs).
//
// All operations target a single default `repo` resolved at construction
// time from `config.repo` (a `group/sub/project` path, any depth) or from
// the local git origin remote when `config.repo` is unset or `"auto"`.
// Per-call `repo` overrides allow targeting a different project when
// needed. A self-managed instance is selected with `config.host`; it is
// passed to glab as GITLAB_HOST (and --hostname for `glab api`), while the
// default is gitlab.com.
//
// GitLab-vs-GitHub shape notes, where the interface contract is stated in
// gh's terms (see interface.mjs):
//   - MR states come back upper-cased ("OPEN", "MERGED", "CLOSED") because
//     callers compare against the vocabulary gh prints; glab's JSON is
//     lower-case.
//   - `search` is GitLab's own syntax (a title/description substring) —
//     except the `merged:>{timestamp}` form the release skill sends, which
//     glab cannot express and this adapter translates into a merged-at
//     filter. An unparseable timestamp throws (silently dropping the cutoff
//     would list every MR ever merged), and a full page whose every row
//     survives the cutoff is flagged `truncated: true` — older in-window
//     MRs may sit on a page this list never fetched.
//   - `workflowRunFind`/`workflowRunWatch` map onto pipelines: a GitLab
//     project runs one pipeline per ref, so the `workflow` name is ignored.
//     Watching polls the pipeline until it reaches a status that cannot
//     change on its own — a `manual` job keeps polling, since approving it
//     resumes the pipeline.
//   - `releaseCreate` has no forge-generated-notes equivalent on GitLab:
//     `generateNotes: true` throws NOT_SUPPORTED — callers pass
//     `generateNotes: false` plus explicit `notes`.
//   - `reviewDecision` is always "" (approvals surface through
//     mergeStateStatus, GitLab's detailed_merge_status).

import '../../lib/require-node.mjs';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  PrNotFound,
  ReleaseNotFound,
  WorkflowNotFound,
  MergeRejected,
  ForgeError,
} from './interface.mjs';

const GITLAB_DEFAULT_HOST = 'gitlab.com';

// Pipeline statuses that cannot change on their own. `manual` deliberately
// reads as non-terminal here: an operator approving the manual job turns
// the pipeline running again, so a watch keeps polling past it.
const PIPELINE_TERMINAL = new Set(['success', 'failed', 'canceled', 'skipped']);

const NOT_FOUND_RE = /404|not\s+found/i;

export function createGitlabAdapter(config, { spawnFn = nodeSpawnSync, pollMs = 5000, maxPolls = 720 } = {}) {
  const defaultRepo = resolveRepo(config, spawnFn);
  const host = typeof config?.host === 'string' && config.host ? config.host : GITLAB_DEFAULT_HOST;

  function glab(args, { input } = {}) {
    // GITLAB_HOST always names the resolved instance — always, because an
    // exported foreign value must not leak into a gitlab.com run — and
    // aims the -R/--repo slugs at it.
    const env = { ...process.env, GITLAB_HOST: host };
    return spawnFn('glab', args, {
      input,
      encoding: 'utf-8',
      env,
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
    });
  }

  function glabOrThrow(args, opts) {
    const result = glab(args, opts);
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

  function repoFor(override) {
    return override || defaultRepo;
  }

  function webUrl(repo, kind, number) {
    return `https://${host}/${repo}/-/${kind}${number !== undefined ? `/${number}` : ''}`;
  }

  async function prCreate({ title, body = '', draft = false, base, head, repo }) {
    if (!title) throw new Error('prCreate: title is required');
    const target = repoFor(repo);
    // glab has no --body-file: the description travels as an argv element.
    const args = ['mr', 'create', '--repo', target, '--title', title, '--description', body, '--yes'];
    if (draft) args.push('--draft');
    if (base) args.push('--target-branch', base);
    if (head) args.push('--source-branch', head);
    const stdout = glabOrThrow(args).trim();
    const m = stdout.match(/\/-\/merge_requests\/(\d+)/);
    if (!m) throw new Error(`Could not parse MR number from glab output: ${stdout}`);
    const number = parseInt(m[1], 10);
    const url = stdout.split('\n').filter(Boolean).find((l) => l.includes(`/-/merge_requests/${number}`)) || webUrl(target, 'merge_requests', number);
    return { id: `${target}!${number}`, url, number };
  }

  // glab's `mr merge` defaults to --auto-merge: with a pipeline still
  // running it only QUEUES the merge and exits 0, which would read as
  // success here while the MR stays open (and task-pr then merges the
  // workspace MR and closes the issue ahead of CI ever publishing).
  // --auto-merge=false makes glab merge now or fail, and the post-merge
  // view verifies the merge actually happened — glab exiting 0 is not
  // proof on its own.
  async function prMerge({ id, strategy = 'merge', deleteBranch = false, repo }) {
    if (!id) throw new Error('prMerge: id is required');
    const { number, repo: parsedRepo } = parseMrId(id, repoFor(repo));
    const before = await prView({ id, repo: parsedRepo });
    if (before.isDraft) {
      throw new MergeRejected(id, 'MR is a draft — mark it ready before merging');
    }
    const args = ['mr', 'merge', String(number), '--repo', parsedRepo, '--yes', '--auto-merge=false'];
    switch (strategy) {
      case 'merge': break; // plain merge is glab's default
      case 'squash': args.push('--squash'); break;
      case 'rebase': args.push('--rebase'); break;
      default: throw new Error(`prMerge: unknown strategy: ${strategy}`);
    }
    if (deleteBranch) args.push('--remove-source-branch');
    const result = glab(args);
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      // Distinguish "not found" from "rejected" so callers can react.
      if (NOT_FOUND_RE.test(stderr)) {
        throw new PrNotFound(id);
      }
      throw new MergeRejected(id, stderr || 'glab mr merge exited non-zero');
    }
    const after = await prView({ id, repo: parsedRepo });
    if (after.state !== 'MERGED') {
      throw new MergeRejected(
        id,
        `MR is still ${after.state} after glab exited 0 — the merge was queued, not applied`,
      );
    }
    return { merged: true, url: after.url };
  }

  async function prView({ id, repo, json }) {
    if (!id) throw new Error('prView: id is required');
    const { number, repo: parsedRepo } = parseMrId(id, repoFor(repo));
    // glab always returns the full MR entity; the `json` field list gh
    // accepts has no equivalent here and is ignored.
    void json;
    const result = glab(['mr', 'view', String(number), '--repo', parsedRepo, '--output', 'json']);
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      if (NOT_FOUND_RE.test(stderr)) {
        throw new PrNotFound(id);
      }
      throw new Error(`glab mr view failed: ${stderr}`);
    }
    const raw = JSON.parse(result.stdout);
    return {
      id,
      number: raw.iid,
      url: raw.web_url,
      state: mrState(raw.state),
      title: raw.title,
      mergeable: raw.has_conflicts ? 'CONFLICTING' : 'MERGEABLE',
      mergeStateStatus: raw.detailed_merge_status ?? raw.merge_status ?? null,
      reviewDecision: '',
      headRefName: raw.source_branch,
      baseRefName: raw.target_branch,
      isDraft: !!raw.draft,
      mergedAt: raw.merged_at,
      _raw: raw,
    };
  }

  // Listing merged MRs is how /release proves the unreleased-notes pile is
  // complete rather than merely empty (gh:89). The release skill bounds the
  // window with GitHub's `merged:>{timestamp}` search syntax; glab has no
  // equivalent filter, so that form is translated here into merged-MRs-only,
  // newest-first, plus a client-side mergedAt cutoff. Anything else passes to
  // glab's own `--search` (a title/description substring) verbatim, per the
  // interface's "the forge's own search syntax" contract.
  //
  // glab returns a single page of `limit` rows. A page that is not full, or
  // one whose oldest rows fall below the cutoff, proves the window's far
  // edge was reached — the list is complete. A full page whose every row
  // survives the cutoff does not: older in-window MRs could sit on a page
  // never fetched, and that maybe-incomplete case is flagged with a
  // non-enumerable `truncated: true` on the returned array, so callers that
  // just map the list never see it.
  async function prList({ state = 'merged', base, head, search, limit = 100, repo }) {
    const target = repoFor(repo);
    const args = ['mr', 'list', '--repo', target, '--output', 'json', '--per-page', String(limit)];
    let mergedAfter = null;
    const searchMatch = search ? String(search).match(/^merged:>\s*(.+)$/) : null;
    if (searchMatch) {
      args.push('--merged', '--order', 'merged_at', '--sort', 'desc');
      mergedAfter = Date.parse(searchMatch[1].trim());
      // An unparseable bound throws instead of silently listing unbounded —
      // the release notes assembled from this list would quietly cover the
      // project's entire history.
      if (Number.isNaN(mergedAfter)) {
        throw new Error(`prList: merged:> needs a parseable timestamp (e.g. merged:>2026-07-01T00:00:00Z), got: ${searchMatch[1].trim()}`);
      }
    } else {
      switch (state) {
        case 'open':
        case 'opened': break; // opened MRs are glab's default listing
        case 'merged': args.push('--merged'); break;
        case 'closed': args.push('--closed'); break;
        case 'all': args.push('--all'); break;
        default: throw new Error(`prList: unknown state: ${state}`);
      }
      if (search) args.push('--search', search);
    }
    if (base) args.push('--target-branch', base);
    if (head) args.push('--source-branch', head);
    const stdout = glabOrThrow(args).trim();
    let raw = stdout ? JSON.parse(stdout) : [];
    const pageFull = raw.length === limit;
    let truncated = pageFull;
    if (mergedAfter !== null) {
      const kept = raw.filter((p) => p.merged_at && Date.parse(p.merged_at) > mergedAfter);
      truncated = pageFull && kept.length === raw.length;
      raw = kept;
    }
    const list = raw.map((p) => ({
      id: p.references?.full ?? `${target}!${p.iid}`,
      number: p.iid,
      title: p.title,
      url: p.web_url,
      headRefName: p.source_branch,
      baseRefName: p.target_branch,
      mergedAt: p.merged_at,
      state: mrState(p.state),
    }));
    if (truncated) Object.defineProperty(list, 'truncated', { value: true });
    return list;
  }

  async function releaseView({ tag, repo }) {
    if (!tag) throw new Error('releaseView: tag is required');
    const target = repoFor(repo);
    const result = glab(['release', 'view', tag, '--repo', target, '--output', 'json']);
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      if (NOT_FOUND_RE.test(stderr)) {
        throw new ReleaseNotFound(tag);
      }
      throw new Error(`glab release view failed: ${stderr}`);
    }
    const raw = JSON.parse(result.stdout);
    return {
      tag: raw.tag_name,
      name: raw.name,
      url: webUrl(target, 'releases', tag),
      publishedAt: raw.released_at ?? raw.created_at,
      isDraft: false,
      isPrerelease: false,
    };
  }

  // GitLab releases carry whatever notes they are given; there is no
  // generate-from-merged-MRs mechanism (gh:157's notes story is GitHub-only).
  // generateNotes: true is therefore a typed NOT_SUPPORTED rather than a
  // silently empty release; callers pass generateNotes: false with `notes`.
  async function releaseCreate({ tag, target, title, generateNotes = true, notes = null, repo }) {
    if (!tag) throw new Error('releaseCreate: tag is required');
    if (generateNotes) {
      throw new ForgeError(
        `GitLab cannot generate release notes from merged MRs — pass generateNotes: false and explicit notes for ${tag}.`,
        'NOT_SUPPORTED',
      );
    }
    const args = ['release', 'create', tag, '--repo', repoFor(repo)];
    if (target) args.push('--ref', target);
    if (title) args.push('--name', title);
    if (notes) args.push('--notes', notes);
    glabOrThrow(args);
    return { url: webUrl(repoFor(repo), 'releases', tag), tag };
  }

  // Pipelines are GitLab's workflow runs: one per ref, so `workflow` (a
  // GitHub workflow-file name) has nothing to select between.
  async function workflowRunFind({ workflow, branch, repo, limit = 1 }) {
    if (!workflow) throw new Error('workflowRunFind: workflow is required');
    void workflow;
    const target = repoFor(repo);
    const args = ['ci', 'list', '--repo', target, '--output', 'json', '--per-page', String(limit)];
    if (branch) args.push('--ref', branch);
    const stdout = glabOrThrow(args).trim();
    const pipelines = stdout ? JSON.parse(stdout) : [];
    if (pipelines.length === 0) return null;
    return normalizePipeline(pipelines[0]);
  }

  // No `glab ci watch` exists — watch polls the pipeline until it reaches a
  // status that cannot change on its own. A `manual` job is not that: an
  // approval resumes the pipeline, so polling continues past it up to the
  // bound (an hour by default), and the timeout names what it waited on. A
  // pipeline that never terminates surfaces as a plain Error, matching the
  // interface's "raw failures throw Error".
  async function workflowRunWatch({ runId, repo, exitStatus = false }) {
    if (!runId) throw new Error('workflowRunWatch: runId is required');
    const target = repoFor(repo);
    const path = `projects/${encodeURIComponent(target)}/pipelines/${runId}`;
    let lastStatus = null;
    for (let i = 0; i < maxPolls; i += 1) {
      const stdout = glabOrThrow(apiArgs(path)).trim();
      let pipeline;
      try {
        pipeline = JSON.parse(stdout);
      } catch (err) {
        throw new Error(`glab api ${path} returned unparseable output: ${err.message}`);
      }
      lastStatus = pipeline.status;
      if (PIPELINE_TERMINAL.has(pipeline.status)) {
        if (!exitStatus || pipeline.status === 'success') return { exitCode: 0 };
        return { exitCode: 1, stderr: `pipeline ${pipeline.status}: ${pipeline.web_url}` };
      }
      if (i < maxPolls - 1) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const waiting = lastStatus === 'manual'
      ? ' — still waiting on a manual job (approve it in the pipeline UI)'
      : '';
    throw new Error(`pipeline ${runId} did not finish within ${Math.round((pollMs * maxPolls) / 60000)} minutes${waiting}`);
  }

  return {
    prCreate,
    prMerge,
    prView,
    prList,
    releaseView,
    releaseCreate,
    workflowRunFind,
    workflowRunWatch,
    get identity() { return `gitlab:${defaultRepo}`; },
  };
}

// MR state in the vocabulary gh prints (OPEN/MERGED/CLOSED) — callers
// compare against those exact strings; glab says "opened".
function mrState(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'opened') return 'OPEN';
  if (s === 'merged') return 'MERGED';
  if (s === 'closed') return 'CLOSED';
  return String(state || '').toUpperCase();
}

// Pipeline status, in GitLab's one-field vocabulary, split into the
// status/conclusion pair gh reports.
function normalizePipeline(raw) {
  const terminal = {
    success: 'success',
    failed: 'failure',
    canceled: 'cancelled',
    skipped: 'skipped',
    manual: 'action_required',
  };
  const running = new Set(['running']);
  const queued = new Set(['created', 'pending', 'preparing', 'waiting_for_resource', 'scheduled']);
  let status;
  let conclusion = null;
  if (raw.status in terminal) {
    status = 'completed';
    conclusion = terminal[raw.status];
  } else if (running.has(raw.status)) {
    status = 'in_progress';
  } else if (queued.has(raw.status)) {
    status = 'queued';
  } else {
    status = raw.status;
  }
  return {
    runId: String(raw.id),
    status,
    conclusion,
    url: raw.web_url,
    branch: raw.ref,
    createdAt: raw.created_at,
  };
}

// "group/sub/project!NUMBER" (any group depth) or just NUMBER (defaulting
// to the adapter's project).
function parseMrId(id, fallbackRepo) {
  if (typeof id === 'number') return { number: id, repo: fallbackRepo };
  const m1 = String(id).match(/^(?<repo>[^!\s]+)!(?<number>\d+)$/);
  if (m1) return { number: parseInt(m1.groups.number, 10), repo: m1.groups.repo };
  const m2 = String(id).match(/^!?(\d+)$/);
  if (m2) return { number: parseInt(m2[1], 10), repo: fallbackRepo };
  throw new Error(`Unparseable MR id: ${id}`);
}

// Like github.mjs's resolveRepo, kept local so the adapter stands alone:
// gitlab.com plus the configured self-managed host, scp-style and scheme
// URLs (an explicit non-default port stays in the host, so `host` can
// carry it — gitlab.example.com:8443), nested groups at any depth,
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
