#!/usr/bin/env node
// Tests for the GitLab forge adapter. Uses an injected spawnFn to mock
// glab calls — no subprocess actually runs.
// Run: node .claude/scripts/forges/gitlab.test.mjs
import { createForge, PrNotFound, ReleaseNotFound, MergeRejected, ForgeError } from './interface.mjs';

let failed = 0, passed = 0;
const ok = () => { passed++; };
const fail = (msg) => { failed++; console.error(`  FAIL: ${msg}`); };

// buildSpawn returns canned responses keyed by argv (matches the pattern
// in github.test.mjs). It also captures env so host handling is observable.
function buildSpawn(responses) {
  const calls = [];
  const fn = (cmd, args, options) => {
    calls.push({ cmd, args: [...args], input: options?.input, env: options?.env });
    const key = args.join(' ');
    // `key in responses` rather than truthy-check — an empty-string response
    // is a legitimate mock (e.g. `glab mr merge` prints nothing on success).
    if (!(key in responses)) {
      return { status: 1, stdout: '', stderr: `no mock for: ${cmd} ${key}` };
    }
    const resp = responses[key];
    if (typeof resp === 'function') return resp(args, options);
    return { status: 0, stdout: resp, stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

const GL_ORIGIN = 'git@gitlab.com:group/sub/proj.git\n';
const PROJECT = 'group/sub/proj';
const MR_URL = `https://gitlab.com/${PROJECT}/-/merge_requests`;

// A merge request entity as `glab ... --output json` prints it (the raw
// GitLab API shape).
const mrEntity = (over = {}) => JSON.stringify({
  iid: 42,
  title: 'feat: the thing',
  state: 'opened',
  source_branch: 'feature/x',
  target_branch: 'main',
  web_url: `${MR_URL}/42`,
  merged_at: null,
  draft: false,
  has_conflicts: false,
  detailed_merge_status: 'not_approved',
  references: { short: '!42', relative: '!42', full: `${PROJECT}!42` },
  ...over,
});

console.log('# prCreate');

// Builds the right argv and parses the MR number out of glab's stdout.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr create --repo ${PROJECT} --title MR title --description body --yes --target-branch main --source-branch feature/x`]:
      `${MR_URL}/42\n`,
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  const pr = await forge.prCreate({ title: 'MR title', body: 'body', base: 'main', head: 'feature/x' });
  if (pr.number === 42 && pr.url === `${MR_URL}/42` && pr.id === `${PROJECT}!42`) ok();
  else fail(`prCreate result wrong: ${JSON.stringify(pr)}`);
  // The description travels as an argv element — glab has no --body-file.
  const create = spawnFn.calls.find(c => c.args.includes('create'));
  if (create.args[create.args.indexOf('--description') + 1] === 'body') ok();
  else fail(`prCreate did not pass the description: ${create.args.join(' ')}`);
}

// draft: true adds --draft.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr create --repo ${PROJECT} --title WIP --description  --yes --draft`]: `${MR_URL}/7\n`,
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  const pr = await forge.prCreate({ title: 'WIP', draft: true });
  if (pr.number === 7) ok();
  else fail(`draft prCreate wrong: ${JSON.stringify(pr)}`);
}

console.log('# prMerge');

// Strategy maps to --squash / --rebase, plain merge adds no flag — and
// --auto-merge=false is always present (glab's default auto-merge would
// queue the merge behind a running pipeline and still exit 0). The merge
// is verified: the MR is viewed before (draft check) and after (it must
// read MERGED).
for (const [strategy, flag] of [['merge', null], ['squash', '--squash'], ['rebase', '--rebase']]) {
  const key = `mr merge 42 --repo ${PROJECT} --yes --auto-merge=false${flag ? ` ${flag}` : ''}`;
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr view 42 --repo ${PROJECT} --output json`]: mrEntity({ state: 'merged', merged_at: '2026-09-06T07:19:52Z' }),
    [key]: '',
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  const res = await forge.prMerge({ id: `${PROJECT}!42`, strategy });
  if (res.merged === true && res.url === `${MR_URL}/42`) ok();
  else fail(`prMerge ${strategy} wrong: ${JSON.stringify(res)}`);
  const views = spawnFn.calls.filter((c) => c.args[1] === 'view');
  if (views.length === 2) ok();
  else fail(`prMerge ${strategy} should view the MR before and after glab: ${views.length} views`);
}

// A queued merge fools glab (exit 0) but not the post-merge view: the MR
// still reads OPEN, so the merge did not happen.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr view 42 --repo ${PROJECT} --output json`]: mrEntity(), // still opened
    [`mr merge 42 --repo ${PROJECT} --yes --auto-merge=false`]: '',
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  let threw = null;
  try { await forge.prMerge({ id: '42' }); } catch (e) { threw = e; }
  if (threw instanceof MergeRejected && /queued/i.test(threw.reason)) ok();
  else fail(`queued merge wrong: ${threw?.message ?? 'no throw'}`);
}

// A draft MR is refused before glab merge is ever called.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr view 42 --repo ${PROJECT} --output json`]: mrEntity({ draft: true }),
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  let threw = null;
  try { await forge.prMerge({ id: '42' }); } catch (e) { threw = e; }
  if (threw instanceof MergeRejected && /draft/i.test(threw.reason)) ok();
  else fail(`draft refusal wrong: ${threw?.message ?? 'no throw'}`);
  if (!spawnFn.calls.some((c) => c.args[1] === 'merge')) ok();
  else fail('glab mr merge ran for a draft MR');
}

// deleteBranch adds --remove-source-branch.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr view 9 --repo ${PROJECT} --output json`]: mrEntity({ iid: 9, state: 'merged' }),
    [`mr merge 9 --repo ${PROJECT} --yes --auto-merge=false --squash --remove-source-branch`]: '',
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  await forge.prMerge({ id: '!9', strategy: 'squash', deleteBranch: true });
  const call = spawnFn.calls.find(c => c.args.includes('merge'));
  if (call.args.includes('--remove-source-branch')) ok();
  else fail(`deleteBranch not passed: ${call.args.join(' ')}`);
}

// Merge that glab rejects with a 404 → throws PrNotFound.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr view 99 --repo ${PROJECT} --output json`]: mrEntity({ iid: 99 }),
    [`mr merge 99 --repo ${PROJECT} --yes --auto-merge=false`]: () => ({
      status: 1, stdout: '', stderr: '404 Not Found',
    }),
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  let threw = null;
  try { await forge.prMerge({ id: `${PROJECT}!99` }); } catch (e) { threw = e; }
  if (threw instanceof PrNotFound) ok();
  else fail(`expected PrNotFound, got: ${threw?.message ?? 'no throw'}`);
}

// Merge rejected for other reasons (405: not mergeable) → MergeRejected.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr view 5 --repo ${PROJECT} --output json`]: mrEntity({ iid: 5 }),
    [`mr merge 5 --repo ${PROJECT} --yes --auto-merge=false`]: () => ({
      status: 1, stdout: '', stderr: '405 Method Not Allowed: Merge request is not yet ready to be merged',
    }),
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  let threw = null;
  try { await forge.prMerge({ id: '5' }); } catch (e) { threw = e; }
  if (threw instanceof MergeRejected && /not yet ready/i.test(threw.reason)) ok();
  else fail(`expected MergeRejected, got: ${threw?.message ?? 'no throw'}`);
}

console.log('# prView');

// Returns normalized fields (upper-cased state) plus a _raw escape hatch.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr view 42 --repo ${PROJECT} --output json`]: mrEntity(),
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  const view = await forge.prView({ id: `${PROJECT}!42` });
  if (view.number === 42 && view.state === 'OPEN' && view.mergeStateStatus === 'not_approved'
      && view.headRefName === 'feature/x' && view.baseRefName === 'main'
      && view._raw.source_branch === 'feature/x') ok();
  else fail(`prView wrong: ${JSON.stringify(view)}`);
  if (view.mergeable === 'MERGEABLE') ok();
  else fail(`prView mergeable wrong: ${view.mergeable}`);
}

// Conflicts and draft surface through the same fields.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr view 8 --repo ${PROJECT} --output json`]: mrEntity({
      iid: 8, has_conflicts: true, draft: true, state: 'merged', merged_at: '2026-09-06T07:19:52Z',
    }),
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  const view = await forge.prView({ id: '!8' });
  if (view.mergeable === 'CONFLICTING' && view.isDraft === true && view.state === 'MERGED'
      && view.mergedAt === '2026-09-06T07:19:52Z') ok();
  else fail(`prView conflict/draft wrong: ${JSON.stringify(view)}`);
}

// not-found surfaces as PrNotFound.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GL_ORIGIN,
    [`mr view 999 --repo ${PROJECT} --output json`]: () => ({ status: 1, stdout: '', stderr: '404 Not Found' }),
  });
  const forge = createForge({ type: 'gitlab' }, { spawnFn });
  let threw = null;
  try { await forge.prView({ id: '999' }); } catch (e) { threw = e; }
  if (threw instanceof PrNotFound) ok();
  else fail(`prView not-found wrong: ${threw?.message ?? 'no throw'}`);
}

console.log('# prList');

// Default state 'merged' maps to --merged; ids come from references.full.
{
  const listJson = JSON.stringify([
    { iid: 78, title: 'fix: three context bugs', web_url: 'https://x/-/merge_requests/78',
      source_branch: 'chore/framework-modernization', target_branch: 'main',
      merged_at: '2026-09-06T07:19:52Z', state: 'merged', references: { full: `${PROJECT}!78` } },
    { iid: 77, title: 'release: v0.17.0-beta.0', web_url: 'https://x/-/merge_requests/77',
      source_branch: 'release/v0.17.0-beta.0', target_branch: 'main',
      merged_at: '2026-08-01T00:00:00Z', state: 'merged', references: {} },
  ]);
  const spawnFn = buildSpawn({
    [`mr list --repo ${PROJECT} --output json --per-page 100 --merged --target-branch main`]: listJson,
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const prs = await forge.prList({ base: 'main' });
  if (prs.length === 2) ok(); else fail(`prList returned ${prs.length}`);
  if (prs[0]?.id === `${PROJECT}!78`) ok(); else fail(`prList id wrong: ${prs[0]?.id}`);
  if (prs[1]?.id === `${PROJECT}!77`) ok(); else fail(`prList id falls back to repo!iid: ${prs[1]?.id}`);
  if (prs[0]?.mergedAt === '2026-09-06T07:19:52Z' && prs[0]?.state === 'MERGED') ok();
  else fail(`prList mergedAt/state wrong: ${JSON.stringify(prs[0])}`);
}

// `head` filters by source branch; open is glab's default listing (no flag).
{
  const spawnFn = buildSpawn({
    [`mr list --repo ${PROJECT} --output json --per-page 100 --source-branch feature/x`]:
      JSON.stringify([{ iid: 9, title: 'feat: x', web_url: 'u', source_branch: 'feature/x',
        target_branch: 'main', merged_at: null, state: 'opened' }]),
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const prs = await forge.prList({ state: 'open', head: 'feature/x' });
  if (prs.length === 1 && prs[0]?.id === `${PROJECT}!9` && prs[0]?.state === 'OPEN') ok();
  else fail(`prList head filter wrong: ${JSON.stringify(prs)}`);
  const list = spawnFn.calls[0].args;
  if (!list.includes('--merged') && !list.includes('--all')) ok();
  else fail(`open state should add no state flag: ${list.join(' ')}`);
}

// GitHub-style `merged:>{date}` search translates to a merged-at cutoff.
{
  const spawnFn = buildSpawn({
    [`mr list --repo ${PROJECT} --output json --per-page 100 --merged --order merged_at --sort desc`]:
      JSON.stringify([
        { iid: 78, title: 'recent', web_url: 'u', source_branch: 'b', target_branch: 'main',
          merged_at: '2026-09-06T07:19:52Z', state: 'merged' },
        { iid: 77, title: 'old', web_url: 'u', source_branch: 'b', target_branch: 'main',
          merged_at: '2026-06-01T00:00:00Z', state: 'merged' },
      ]),
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const prs = await forge.prList({ search: 'merged:>2026-07-01' });
  if (prs.length === 1 && prs[0]?.number === 78) ok();
  else fail(`merged:> filter wrong: ${JSON.stringify(prs.map((p) => p.number))}`);
  const list = spawnFn.calls[0].args;
  if (list.includes('--order') && list.includes('merged_at')) ok();
  else fail(`merged search should order by merged_at: ${list.join(' ')}`);
}

// Any other search passes to glab's own --search verbatim.
{
  const spawnFn = buildSpawn({
    [`mr list --repo ${PROJECT} --output json --per-page 100 --merged --search fix auth`]: '[]',
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const prs = await forge.prList({ search: 'fix auth' });
  if (Array.isArray(prs) && prs.length === 0) ok();
  else fail(`plain search wrong: ${JSON.stringify(prs)}`);
}

// An unknown state is an error, not a silent wrong listing.
{
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn: buildSpawn({}) });
  let threw = null;
  try { await forge.prList({ state: 'locked' }); } catch (e) { threw = e; }
  if (threw && /unknown state/.test(threw.message)) ok();
  else fail(`unknown state wrong: ${threw?.message ?? 'no throw'}`);
}

// Empty stdout is a legitimate answer (github.test.mjs tolerates the same).
{
  const spawnFn = buildSpawn({
    [`mr list --repo ${PROJECT} --output json --per-page 100 --merged`]: '',
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const prs = await forge.prList({});
  if (Array.isArray(prs) && prs.length === 0) ok();
  else fail(`prList on empty stdout should be [], got ${JSON.stringify(prs)}`);
}

console.log('# releaseView');

// Normalizes the GitLab release entity.
{
  const spawnFn = buildSpawn({
    [`release view v1.2.3 --repo ${PROJECT} --output json`]: JSON.stringify({
      tag_name: 'v1.2.3', name: 'Release 1.2.3', description: 'notes',
      released_at: '2026-05-01T00:00:00Z', created_at: '2026-05-01T00:00:00Z',
    }),
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const rel = await forge.releaseView({ tag: 'v1.2.3' });
  if (rel.tag === 'v1.2.3' && rel.name === 'Release 1.2.3' && rel.publishedAt === '2026-05-01T00:00:00Z'
      && rel.url === `https://gitlab.com/${PROJECT}/-/releases/v1.2.3`) ok();
  else fail(`releaseView wrong: ${JSON.stringify(rel)}`);
}

// not-found surfaces as ReleaseNotFound.
{
  const spawnFn = buildSpawn({
    [`release view v9.9.9 --repo ${PROJECT} --output json`]: () => ({
      status: 1, stdout: '', stderr: '404 Not Found release not found',
    }),
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  let threw = null;
  try { await forge.releaseView({ tag: 'v9.9.9' }); } catch (e) { threw = e; }
  if (threw instanceof ReleaseNotFound) ok();
  else fail(`releaseView not-found wrong: ${threw?.message ?? 'no throw'}`);
}

console.log('# releaseCreate');

// GitLab cannot generate notes — generateNotes: true is a typed NOT_SUPPORTED.
{
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn: buildSpawn({}) });
  let threw = null;
  try { await forge.releaseCreate({ tag: 'v1.0.0' }); } catch (e) { threw = e; }
  if (threw instanceof ForgeError && threw.code === 'NOT_SUPPORTED' && /generateNotes/.test(threw.message)) ok();
  else fail(`generateNotes wrong: ${threw?.message ?? 'no throw'}`);
}

// generateNotes: false builds the argv and returns the release URL.
{
  const spawnFn = buildSpawn({
    [`release create v1.2.3 --repo ${PROJECT} --ref abc123 --name Release 1.2.3 --notes the notes`]: '',
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const rel = await forge.releaseCreate({
    tag: 'v1.2.3', target: 'abc123', title: 'Release 1.2.3', generateNotes: false, notes: 'the notes',
  });
  if (rel.tag === 'v1.2.3' && rel.url === `https://gitlab.com/${PROJECT}/-/releases/v1.2.3`) ok();
  else fail(`releaseCreate wrong: ${JSON.stringify(rel)}`);
}

// Without target/title/notes the argv is minimal: repo + tag only.
{
  const spawnFn = buildSpawn({
    [`release create v0.1.0 --repo ${PROJECT}`]: '',
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const rel = await forge.releaseCreate({ tag: 'v0.1.0', generateNotes: false });
  if (rel.url === `https://gitlab.com/${PROJECT}/-/releases/v0.1.0`) ok();
  else fail(`releaseCreate minimal wrong: ${JSON.stringify(rel)}`);
  const call = spawnFn.calls.find(c => c.args.includes('create'));
  if (call.args.includes('--ref') || call.args.includes('--name') || call.args.includes('--notes')) {
    fail(`releaseCreate passed unset flags: ${call.args.join(' ')}`);
  } else ok();
}

console.log('# workflowRunFind');

// Pipelines are the workflow-run equivalent; statuses map to gh's vocabulary.
{
  const spawnFn = buildSpawn({
    [`ci list --repo ${PROJECT} --output json --per-page 1 --ref v1.2.3`]: JSON.stringify([{
      id: 12345, status: 'running', web_url: `https://gitlab.com/${PROJECT}/-/pipelines/12345`,
      ref: 'v1.2.3', created_at: '2026-05-01T00:00:00Z',
    }]),
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const run = await forge.workflowRunFind({ workflow: 'publish.yml', branch: 'v1.2.3' });
  if (run.runId === '12345' && run.status === 'in_progress' && run.conclusion === null
      && run.branch === 'v1.2.3') ok();
  else fail(`workflowRunFind wrong: ${JSON.stringify(run)}`);
}

// Terminal pipeline statuses split into status + conclusion.
for (const [gl, status, conclusion] of [
  ['success', 'completed', 'success'],
  ['failed', 'completed', 'failure'],
  ['canceled', 'completed', 'cancelled'],
  ['manual', 'completed', 'action_required'],
  ['pending', 'queued', null],
]) {
  const spawnFn = buildSpawn({
    [`ci list --repo ${PROJECT} --output json --per-page 1 --ref main`]:
      JSON.stringify([{ id: 1, status: gl, web_url: 'u', ref: 'main', created_at: 'd' }]),
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const run = await forge.workflowRunFind({ workflow: 'ci.yml', branch: 'main' });
  if (run.status === status && run.conclusion === conclusion) ok();
  else fail(`pipeline mapping ${gl} wrong: ${JSON.stringify(run)}`);
}

// No pipelines for the ref → null.
{
  const spawnFn = buildSpawn({
    [`ci list --repo ${PROJECT} --output json --per-page 1 --ref v0.0.0`]: '[]',
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const run = await forge.workflowRunFind({ workflow: 'publish.yml', branch: 'v0.0.0' });
  if (run === null) ok();
  else fail(`workflowRunFind no-results wrong: ${JSON.stringify(run)}`);
}

console.log('# workflowRunWatch');

// The pipeline poll always names the host (--hostname) — even gitlab.com.
const pipelineApi = (id) => `api projects/${encodeURIComponent(PROJECT)}/pipelines/${id} --hostname gitlab.com`;

// Success after one running poll: exit 0. pollMs is shrunk so the test
// never actually waits.
{
  let polls = 0;
  const spawnFn = buildSpawn({
    [pipelineApi(999)]: () => {
      polls += 1;
      return { status: 0, stdout: JSON.stringify({ id: 999, status: polls === 1 ? 'running' : 'success', web_url: 'u' }), stderr: '' };
    },
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn, pollMs: 1 });
  const res = await forge.workflowRunWatch({ runId: '999', exitStatus: true });
  if (res.exitCode === 0 && polls === 2) ok();
  else fail(`workflowRunWatch success wrong: ${JSON.stringify(res)} polls=${polls}`);
}

// A failed pipeline with exitStatus → exitCode 1 plus the failure URL.
{
  const spawnFn = buildSpawn({
    [pipelineApi(999)]: JSON.stringify({ id: 999, status: 'failed', web_url: 'https://x/-/pipelines/999' }),
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn, pollMs: 1 });
  const res = await forge.workflowRunWatch({ runId: '999', exitStatus: true });
  if (res.exitCode === 1 && /pipelines\/999/.test(res.stderr)) ok();
  else fail(`workflowRunWatch failure wrong: ${JSON.stringify(res)}`);
}

// Without exitStatus a failed run still reports 0 (gh watch's default).
{
  const spawnFn = buildSpawn({
    [pipelineApi(999)]: JSON.stringify({ id: 999, status: 'failed', web_url: 'u' }),
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn, pollMs: 1 });
  const res = await forge.workflowRunWatch({ runId: '999' });
  if (res.exitCode === 0) ok();
  else fail(`workflowRunWatch no-exitStatus wrong: ${JSON.stringify(res)}`);
}

// `manual` is not terminal for a watch — approving the manual job resumes
// the pipeline, so polling continues past it.
{
  let polls = 0;
  const spawnFn = buildSpawn({
    [pipelineApi(11)]: () => {
      polls += 1;
      return { status: 0, stdout: JSON.stringify({ id: 11, status: polls === 1 ? 'manual' : 'success', web_url: 'u' }), stderr: '' };
    },
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn, pollMs: 1 });
  const res = await forge.workflowRunWatch({ runId: '11', exitStatus: true });
  if (res.exitCode === 0 && polls === 2) ok();
  else fail(`workflowRunWatch manual-through wrong: ${JSON.stringify(res)} polls=${polls}`);
}

// A pipeline stuck on manual until the bound: the timeout names what it
// waited on.
{
  const spawnFn = buildSpawn({
    [pipelineApi(12)]: JSON.stringify({ id: 12, status: 'manual', web_url: 'u' }),
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn, pollMs: 1, maxPolls: 2 });
  let threw = null;
  try { await forge.workflowRunWatch({ runId: '12' }); } catch (e) { threw = e; }
  if (threw && /manual job/.test(threw.message)) ok();
  else fail(`workflowRunWatch manual timeout wrong: ${threw?.message ?? 'no throw'}`);
}

console.log('# repo resolution and self-managed hosts');

// Explicit config.repo wins over the git remote; no git call happens.
{
  const spawnFn = buildSpawn({});
  const forge = createForge({ type: 'gitlab', repo: 'explicit/sub/repo' }, { spawnFn });
  if (forge.identity === 'gitlab:explicit/sub/repo' && spawnFn.calls.length === 0) ok();
  else fail(`explicit repo failed: identity=${forge.identity} calls=${spawnFn.calls.length}`);
}

// 'auto' parses nested groups from any URL shape.
for (const [url, expected] of [
  ['git@gitlab.com:group/sub/proj.git\n', PROJECT],
  ['https://gitlab.com/group/sub/proj.git\n', PROJECT],
  ['ssh://git@gitlab.com/group/sub/proj.git\n', PROJECT],
  ['https://gitlab.com/group/proj\n', 'group/proj'],
]) {
  const spawnFn = buildSpawn({ 'remote get-url origin': url });
  const forge = createForge({ type: 'gitlab', repo: 'auto' }, { spawnFn });
  if (forge.identity === `gitlab:${expected}`) ok();
  else fail(`auto-resolve ${url.trim()} wrong: identity=${forge.identity}`);
}

// A self-managed host: GITLAB_HOST is set for -R commands, --hostname for
// glab api, and URLs build against the host.
{
  const host = 'gitlab.example.com';
  const spawnFn = buildSpawn({
    'remote get-url origin': `git@${host}:acme/team/app.git\n`,
    [`mr list --repo acme/team/app --output json --per-page 100 --merged`]: '[]',
    [`api projects/${encodeURIComponent('acme/team/app')}/pipelines/7 --hostname ${host}`]:
      JSON.stringify({ id: 7, status: 'success', web_url: 'u' }),
  });
  const forge = createForge({ type: 'gitlab', host, repo: 'auto' }, { spawnFn, pollMs: 1 });
  if (forge.identity === 'gitlab:acme/team/app') ok();
  else fail(`self-managed identity wrong: ${forge.identity}`);
  await forge.prList({});
  const list = spawnFn.calls.find(c => c.args.includes('list'));
  if (list?.env?.GITLAB_HOST === host) ok();
  else fail(`GITLAB_HOST not set for -R command: ${JSON.stringify(list?.env)}`);
  const res = await forge.workflowRunWatch({ runId: '7', exitStatus: true });
  if (res.exitCode === 0) ok();
  else fail(`self-managed watch wrong: ${JSON.stringify(res)}`);
  const api = spawnFn.calls.find(c => c.args[0] === 'api');
  if (api?.args.includes('--hostname') && api?.args[api?.args.indexOf('--hostname') + 1] === host) ok();
  else fail(`--hostname not passed to glab api: ${api?.args.join(' ')}`);
}

// A self-managed origin on a non-default port: the port stays in the
// host, so config.host carries it too (and GITLAB_HOST names it).
{
  const host = 'gitlab.example.com:8443';
  const spawnFn = buildSpawn({
    'remote get-url origin': `https://${host}/acme/team/app.git\n`,
    [`mr list --repo acme/team/app --output json --per-page 100 --merged`]: '[]',
  });
  const forge = createForge({ type: 'gitlab', host, repo: 'auto' }, { spawnFn });
  if (forge.identity === 'gitlab:acme/team/app') ok();
  else fail(`port host identity wrong: ${forge.identity}`);
  await forge.prList({});
  const list = spawnFn.calls.find((c) => c.args.includes('list'));
  if (list?.env?.GITLAB_HOST === host) ok();
  else fail(`port not kept in GITLAB_HOST: ${JSON.stringify(list?.env?.GITLAB_HOST)}`);
}

// An exported GITLAB_HOST for some other instance never leaks into a
// gitlab.com run — the adapter always names its own host.
{
  const spawnFn = buildSpawn({
    [`mr list --repo ${PROJECT} --output json --per-page 100 --merged`]: '[]',
  });
  const forge = createForge({ type: 'gitlab', repo: PROJECT }, { spawnFn });
  const prev = process.env.GITLAB_HOST;
  process.env.GITLAB_HOST = 'elsewhere.example.com';
  try {
    await forge.prList({});
    const list = spawnFn.calls.find((c) => c.args.includes('list'));
    if (list?.env?.GITLAB_HOST === 'gitlab.com') ok();
    else fail(`foreign GITLAB_HOST leaked: ${JSON.stringify(list?.env?.GITLAB_HOST)}`);
  } finally {
    if (prev === undefined) delete process.env.GITLAB_HOST;
    else process.env.GITLAB_HOST = prev;
  }
}

// An origin that is not a GitLab host is a construction error, not a
// silent github.com fallback.
{
  const spawnFn = buildSpawn({ 'remote get-url origin': 'git@github.com:foo/bar.git\n' });
  let threw = null;
  try { createForge({ type: 'gitlab' }, { spawnFn }); } catch (e) { threw = e; }
  if (threw && /Cannot parse GitLab remote/.test(threw.message)) ok();
  else fail(`non-gitlab origin wrong: ${threw?.message ?? 'no throw'}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
