#!/usr/bin/env node
// Tests for the GitHub forge adapter. Uses an injected spawnFn to mock
// gh calls — no subprocess actually runs.
// Run: node .claude/scripts/forges/github.test.mjs
import {
  createForge,
  PrNotFound,
  ReleaseNotFound,
  WorkflowNotFound,
  MergeRejected,
} from './interface.mjs';

let failed = 0, passed = 0;
const ok = () => { passed++; };
const fail = (msg) => { failed++; console.error(`  FAIL: ${msg}`); };

// buildSpawn returns canned responses keyed by argv (matches the pattern
// in trackers/github-issues.test.mjs).
function buildSpawn(responses) {
  const calls = [];
  const fn = (cmd, args, options) => {
    calls.push({ cmd, args: [...args], input: options?.input });
    const key = args.join(' ');
    // `key in responses` rather than truthy-check — an empty-string response
    // is a legitimate mock (e.g. `gh pr merge` prints nothing on success).
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

const GH_ORIGIN = 'git@github.com:foo/bar.git\n';

console.log('# prCreate');

// Builds the right argv and parses the URL out of gh's stdout.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'pr create --repo foo/bar --title PR title --body-file - --base main --head feature/x':
      'https://github.com/foo/bar/pull/42\n',
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const pr = await forge.prCreate({ title: 'PR title', body: 'body', base: 'main', head: 'feature/x' });
  if (pr.number === 42 && pr.url === 'https://github.com/foo/bar/pull/42' && pr.id === 'foo/bar#42') ok();
  else fail(`prCreate result wrong: ${JSON.stringify(pr)}`);

  // body is piped on stdin via --body-file -
  const create = spawnFn.calls.find(c => c.args.includes('create'));
  if (create.input === 'body') ok();
  else fail(`prCreate did not pipe body on stdin: input=${create.input}`);
}

// draft: true adds --draft.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'pr create --repo foo/bar --title WIP --body-file - --draft':
      'https://github.com/foo/bar/pull/7\n',
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const pr = await forge.prCreate({ title: 'WIP', draft: true });
  if (pr.number === 7) ok();
  else fail(`draft prCreate wrong: ${JSON.stringify(pr)}`);
}

console.log('# prMerge');

// Strategy maps to --merge / --squash / --rebase.
for (const [strategy, flag] of [['merge', '--merge'], ['squash', '--squash'], ['rebase', '--rebase']]) {
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    [`pr merge 42 --repo foo/bar ${flag}`]: '',
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const res = await forge.prMerge({ id: 'foo/bar#42', strategy });
  if (res.merged === true && res.url === 'https://github.com/foo/bar/pull/42') ok();
  else fail(`prMerge ${strategy} wrong: ${JSON.stringify(res)}`);
}

// deleteBranch adds --delete-branch.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'pr merge 9 --repo foo/bar --squash --delete-branch': '',
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  await forge.prMerge({ id: '#9', strategy: 'squash', deleteBranch: true });
  const call = spawnFn.calls.find(c => c.args.includes('merge'));
  if (call.args.includes('--delete-branch')) ok();
  else fail(`deleteBranch not passed: ${call.args.join(' ')}`);
}

// Merge that gh rejects with a "not found" error → throws PrNotFound.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'pr merge 99 --repo foo/bar --merge': () => ({
      status: 1, stdout: '', stderr: 'could not resolve pull request: not found',
    }),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  let threw = null;
  try { await forge.prMerge({ id: 'foo/bar#99' }); } catch (e) { threw = e; }
  if (threw instanceof PrNotFound) ok();
  else fail(`expected PrNotFound, got: ${threw?.message ?? 'no throw'}`);
}

// Merge that gh rejects for other reasons → throws MergeRejected with the gh stderr.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'pr merge 5 --repo foo/bar --merge': () => ({
      status: 1, stdout: '', stderr: 'PR is not mergeable: required reviews missing',
    }),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  let threw = null;
  try { await forge.prMerge({ id: '5' }); } catch (e) { threw = e; }
  if (threw instanceof MergeRejected && /required reviews/i.test(threw.reason)) ok();
  else fail(`expected MergeRejected, got: ${threw?.message ?? 'no throw'}`);
}

console.log('# prView');

// Returns normalized fields plus a _raw escape hatch.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'pr view 42 --repo foo/bar --json number,url,state,title,mergeable,mergeStateStatus,reviewDecision,headRefName,baseRefName,isDraft,mergedAt':
      JSON.stringify({
        number: 42, url: 'https://github.com/foo/bar/pull/42', state: 'OPEN',
        title: 'PR title', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        reviewDecision: '', headRefName: 'feature/x', baseRefName: 'main',
        isDraft: false, mergedAt: null,
      }),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const view = await forge.prView({ id: 'foo/bar#42' });
  if (view.number === 42 && view.state === 'OPEN' && view.mergeable === 'MERGEABLE'
      && view._raw.headRefName === 'feature/x') ok();
  else fail(`prView wrong: ${JSON.stringify(view)}`);
}

// not-found surfaces as PrNotFound.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'pr view 999 --repo foo/bar --json number,url,state,title,mergeable,mergeStateStatus,reviewDecision,headRefName,baseRefName,isDraft,mergedAt':
      () => ({ status: 1, stdout: '', stderr: 'pull request not found' }),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  let threw = null;
  try { await forge.prView({ id: '999' }); } catch (e) { threw = e; }
  if (threw instanceof PrNotFound) ok();
  else fail(`prView not-found wrong: ${threw?.message ?? 'no throw'}`);
}

console.log('# prList');
{
  const listJson = JSON.stringify([
    { number: 78, title: 'fix: three context bugs', url: 'https://x/pull/78',
      headRefName: 'chore/framework-modernization', baseRefName: 'main',
      mergedAt: '2026-09-06T07:19:52Z', state: 'MERGED' },
    { number: 77, title: 'release: v0.17.0-beta.0', url: 'https://x/pull/77',
      headRefName: 'release/v0.17.0-beta.0', baseRefName: 'main',
      mergedAt: '2026-08-01T00:00:00Z', state: 'MERGED' },
  ]);
  const key = 'pr list --repo foo/bar --state merged --limit 100 --json '
    + 'number,title,url,headRefName,baseRefName,mergedAt,state --base main '
    + '--search merged:>2026-07-01';
  const spawnFn = buildSpawn({ [key]: listJson });
  const forge = createForge({ type: 'github', repo: 'foo/bar' }, { spawnFn });
  const prs = await forge.prList({ base: 'main', search: 'merged:>2026-07-01' });
  if (prs.length === 2) ok(); else fail(`prList returned ${prs.length}`);
  if (prs[0]?.id === 'foo/bar#78') ok(); else fail(`prList id wrong: ${prs[0]?.id}`);
  if (prs[0]?.headRefName === 'chore/framework-modernization') ok();
  else fail(`prList headRefName wrong: ${prs[0]?.headRefName}`);
  if (prs[0]?.mergedAt === '2026-09-06T07:19:52Z') ok(); else fail('prList mergedAt wrong');
  if (spawnFn.calls[0].args.includes('--search')) ok(); else fail('prList did not pass --search');
  if (spawnFn.calls[0].args.includes('merged')) ok(); else fail('prList did not pass state');
}

{
  // An empty list is a legitimate answer, not a parse error. gh prints
  // nothing at all in some versions, so the adapter must tolerate '' too.
  const key = 'pr list --repo foo/bar --state merged --limit 100 --json '
    + 'number,title,url,headRefName,baseRefName,mergedAt,state';
  const spawnFn = buildSpawn({ [key]: '' });
  const forge = createForge({ type: 'github', repo: 'foo/bar' }, { spawnFn });
  const prs = await forge.prList({});
  if (Array.isArray(prs) && prs.length === 0) ok();
  else fail(`prList on empty stdout should be [], got ${JSON.stringify(prs)}`);
}

{
  // `head` filters by source branch — how task-pr.mjs finds the PR a
  // previous --create run already opened for the task branch.
  const listJson = JSON.stringify([
    { number: 9, title: 'feat: x', url: 'https://x/pull/9',
      headRefName: 'feature/x', baseRefName: 'main', mergedAt: null, state: 'OPEN' },
  ]);
  const key = 'pr list --repo foo/bar --state open --limit 100 --json '
    + 'number,title,url,headRefName,baseRefName,mergedAt,state --head feature/x';
  const spawnFn = buildSpawn({ [key]: listJson });
  const forge = createForge({ type: 'github', repo: 'foo/bar' }, { spawnFn });
  const prs = await forge.prList({ state: 'open', head: 'feature/x' });
  if (prs.length === 1 && prs[0]?.id === 'foo/bar#9' && prs[0]?.state === 'OPEN') ok();
  else fail(`prList head filter wrong: ${JSON.stringify(prs)}`);
}

console.log('# prChecks');

const CHECKS_KEY = 'pr checks 42 --repo foo/bar --json name,state,bucket,link';
const CHECKS_URL = 'https://github.com/foo/bar/pull/42/checks';

// All-pass rows → success; the argv asks for the bucket categorization
// the aggregate state is derived from.
{
  const spawnFn = buildSpawn({
    [CHECKS_KEY]: JSON.stringify([
      { name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://x/build' },
      { name: 'lint', state: 'SKIPPED', bucket: 'skipping', link: 'https://x/lint' },
    ]),
  });
  const forge = createForge({ type: 'github', repo: 'foo/bar' }, { spawnFn });
  const checks = await forge.prChecks({ id: 'foo/bar#42' });
  if (checks.state === 'success' && checks.url === CHECKS_URL && checks.failing.length === 0) ok();
  else fail(`prChecks success wrong: ${JSON.stringify(checks)}`);
  if (spawnFn.calls[0].args.join(' ') === CHECKS_KEY) ok();
  else fail(`prChecks argv wrong: ${spawnFn.calls[0].args.join(' ')}`);
}

// A failing row: gh exits 1 with the checks JSON still on stdout — the
// JSON is the answer, the exit status carries nothing it does not. The
// failing list names the failed check and its link.
{
  const spawnFn = buildSpawn({
    [CHECKS_KEY]: () => ({
      status: 1,
      stdout: JSON.stringify([
        { name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://x/build' },
        { name: 'test', state: 'FAILURE', bucket: 'fail', link: 'https://x/test' },
      ]),
      stderr: 'some checks were failing',
    }),
  });
  const forge = createForge({ type: 'github', repo: 'foo/bar' }, { spawnFn });
  const checks = await forge.prChecks({ id: 'foo/bar#42' });
  if (checks.state === 'failure' && checks.failing.length === 1
      && checks.failing[0].name === 'test' && checks.failing[0].url === 'https://x/test') ok();
  else fail(`prChecks failure wrong: ${JSON.stringify(checks)}`);
}

// Pending rows: gh exits 8 — again the JSON decides, and the state is
// pending, not failure.
{
  const spawnFn = buildSpawn({
    [CHECKS_KEY]: () => ({
      status: 8,
      stdout: JSON.stringify([
        { name: 'build', state: 'IN_PROGRESS', bucket: 'pending', link: 'https://x/build' },
      ]),
      stderr: '',
    }),
  });
  const forge = createForge({ type: 'github', repo: 'foo/bar' }, { spawnFn });
  const checks = await forge.prChecks({ id: 'foo/bar#42' });
  if (checks.state === 'pending' && checks.failing.length === 0) ok();
  else fail(`prChecks pending wrong: ${JSON.stringify(checks)}`);
}

// No rows at all → 'none' (no CI configured on the PR).
{
  const spawnFn = buildSpawn({ [CHECKS_KEY]: '[]' });
  const forge = createForge({ type: 'github', repo: 'foo/bar' }, { spawnFn });
  const checks = await forge.prChecks({ id: 'foo/bar#42' });
  if (checks.state === 'none' && checks.failing.length === 0) ok();
  else fail(`prChecks none wrong: ${JSON.stringify(checks)}`);
}

// A cancelled check never passed — it counts as failing, not as done.
{
  const spawnFn = buildSpawn({
    [CHECKS_KEY]: JSON.stringify([
      { name: 'e2e', state: 'CANCELLED', bucket: 'cancel', link: 'https://x/e2e' },
    ]),
  });
  const forge = createForge({ type: 'github', repo: 'foo/bar' }, { spawnFn });
  const checks = await forge.prChecks({ id: 'foo/bar#42' });
  if (checks.state === 'failure' && checks.failing[0]?.name === 'e2e') ok();
  else fail(`prChecks cancel wrong: ${JSON.stringify(checks)}`);
}

// Output that is not JSON — gh printing prose on an auth or network
// failure — is the one real error, whatever the exit status.
{
  const spawnFn = buildSpawn({
    [CHECKS_KEY]: () => ({ status: 1, stdout: '', stderr: 'gh: authentication required' }),
  });
  const forge = createForge({ type: 'github', repo: 'foo/bar' }, { spawnFn });
  let threw = null;
  try { await forge.prChecks({ id: 'foo/bar#42' }); } catch (e) { threw = e; }
  if (threw && /authentication required/.test(threw.message)) ok();
  else fail(`prChecks non-JSON wrong: ${threw?.message ?? 'no throw'}`);
}

console.log('# releaseView');

// Normalizes the JSON gh release view returns.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'release view v1.2.3 --repo foo/bar --json name,tagName,url,publishedAt,isDraft,isPrerelease':
      JSON.stringify({
        name: 'Release 1.2.3', tagName: 'v1.2.3',
        url: 'https://github.com/foo/bar/releases/tag/v1.2.3',
        publishedAt: '2026-05-01T00:00:00Z', isDraft: false, isPrerelease: false,
      }),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const rel = await forge.releaseView({ tag: 'v1.2.3' });
  if (rel.tag === 'v1.2.3' && rel.name === 'Release 1.2.3'
      && rel.url === 'https://github.com/foo/bar/releases/tag/v1.2.3' && rel.isPrerelease === false) ok();
  else fail(`releaseView wrong: ${JSON.stringify(rel)}`);
}

// not-found surfaces as ReleaseNotFound.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'release view v9.9.9 --repo foo/bar --json name,tagName,url,publishedAt,isDraft,isPrerelease':
      () => ({ status: 1, stdout: '', stderr: 'release not found' }),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  let threw = null;
  try { await forge.releaseView({ tag: 'v9.9.9' }); } catch (e) { threw = e; }
  if (threw instanceof ReleaseNotFound) ok();
  else fail(`releaseView not-found wrong: ${threw?.message ?? 'no throw'}`);
}

console.log('# releaseCreate');

// Builds the right argv with all options and parses the URL from stdout.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'release create v1.2.3 --repo foo/bar --target abc123 --title Release 1.2.3 --generate-notes':
      'https://github.com/foo/bar/releases/tag/v1.2.3\n',
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const rel = await forge.releaseCreate({ tag: 'v1.2.3', target: 'abc123', title: 'Release 1.2.3' });
  if (rel.tag === 'v1.2.3' && rel.url === 'https://github.com/foo/bar/releases/tag/v1.2.3') ok();
  else fail(`releaseCreate full wrong: ${JSON.stringify(rel)}`);
}

// Without target/title/generateNotes the argv is minimal: repo + tag only.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'release create v0.1.0 --repo foo/bar': 'https://github.com/foo/bar/releases/tag/v0.1.0\n',
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const rel = await forge.releaseCreate({ tag: 'v0.1.0', generateNotes: false });
  if (rel.url === 'https://github.com/foo/bar/releases/tag/v0.1.0') ok();
  else fail(`releaseCreate minimal wrong: ${JSON.stringify(rel)}`);
  const call = spawnFn.calls.find(c => c.args.includes('create'));
  if (call.args.includes('--generate-notes')) fail('releaseCreate passed --generate-notes despite generateNotes: false');
  else ok();
  if (call.args.includes('--target') || call.args.includes('--title')) fail('releaseCreate passed target/title when unset');
  else ok();
}

// URL is the last stdout line (gh may print warnings first).
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'release create v2.0.0 --repo foo/bar --generate-notes':
      'warning: something verbose\nhttps://github.com/foo/bar/releases/tag/v2.0.0\n\n',
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const rel = await forge.releaseCreate({ tag: 'v2.0.0' });
  if (rel.url === 'https://github.com/foo/bar/releases/tag/v2.0.0') ok();
  else fail(`releaseCreate URL parse wrong: ${JSON.stringify(rel)}`);
}

// Non-zero exit throws with stderr.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'release create v3.0.0 --repo foo/bar --generate-notes': () => ({
      status: 1, stdout: '', stderr: 'tag already exists',
    }),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  let threw = null;
  try { await forge.releaseCreate({ tag: 'v3.0.0' }); } catch (e) { threw = e; }
  if (threw && /tag already exists/.test(threw.message)) ok();
  else fail(`releaseCreate failure wrong: ${threw?.message ?? 'no throw'}`);
}

console.log('# workflowRunFind');

// Finds the most recent run for a workflow/branch, returns null when none.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'run list --repo foo/bar --workflow publish.yml --limit 1 --json databaseId,status,conclusion,url,headBranch,createdAt --branch v1.2.3':
      JSON.stringify([{
        databaseId: 12345, status: 'completed', conclusion: 'success',
        url: 'https://github.com/foo/bar/actions/runs/12345',
        headBranch: 'v1.2.3', createdAt: '2026-05-01T00:00:00Z',
      }]),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const run = await forge.workflowRunFind({ workflow: 'publish.yml', branch: 'v1.2.3' });
  if (run.runId === '12345' && run.status === 'completed' && run.conclusion === 'success') ok();
  else fail(`workflowRunFind wrong: ${JSON.stringify(run)}`);
}

{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'run list --repo foo/bar --workflow publish.yml --limit 1 --json databaseId,status,conclusion,url,headBranch,createdAt --branch v0.0.0':
      JSON.stringify([]),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const run = await forge.workflowRunFind({ workflow: 'publish.yml', branch: 'v0.0.0' });
  if (run === null) ok();
  else fail(`workflowRunFind no-results wrong: ${JSON.stringify(run)}`);
}

console.log('# workflowRunWatch');

// Success: exit 0, returns { exitCode: 0 }.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'run watch 999 --repo foo/bar --exit-status': '',
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const res = await forge.workflowRunWatch({ runId: '999', exitStatus: true });
  if (res.exitCode === 0) ok();
  else fail(`workflowRunWatch success wrong: ${JSON.stringify(res)}`);
}

// Failure: non-zero exit code surfaces via res.exitCode without throwing,
// so callers can record the failure URL.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'run watch 999 --repo foo/bar --exit-status': () => ({
      status: 1, stdout: '', stderr: 'workflow run failed',
    }),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  const res = await forge.workflowRunWatch({ runId: '999', exitStatus: true });
  if (res.exitCode === 1 && /failed/.test(res.stderr)) ok();
  else fail(`workflowRunWatch failure wrong: ${JSON.stringify(res)}`);
}

// "Not found" stderr surfaces as WorkflowNotFound.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': GH_ORIGIN,
    'run watch 999 --repo foo/bar': () => ({
      status: 1, stdout: '', stderr: 'could not find workflow run',
    }),
  });
  const forge = createForge({ type: 'github' }, { spawnFn });
  let threw = null;
  try { await forge.workflowRunWatch({ runId: '999' }); } catch (e) { threw = e; }
  if (threw instanceof WorkflowNotFound) ok();
  else fail(`workflowRunWatch not-found wrong: ${threw?.message ?? 'no throw'}`);
}

console.log('# repo resolution');

// Explicit config.repo wins over the git remote.
{
  let calledGit = false;
  const spawnFn = buildSpawn({});
  const wrapped = (cmd, args, opts) => {
    if (cmd === 'git') calledGit = true;
    return spawnFn(cmd, args, opts);
  };
  const forge = createForge({ type: 'github', repo: 'explicit/repo' }, { spawnFn: wrapped });
  if (forge.identity === 'github:explicit/repo' && !calledGit) ok();
  else fail(`explicit repo failed: identity=${forge.identity} calledGit=${calledGit}`);
}

// 'auto' falls back to parsing the git remote.
{
  const spawnFn = buildSpawn({
    'remote get-url origin': 'https://github.com/some/proj.git\n',
  });
  const forge = createForge({ type: 'github', repo: 'auto' }, { spawnFn });
  if (forge.identity === 'github:some/proj') ok();
  else fail(`auto-resolve wrong: identity=${forge.identity}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
