#!/usr/bin/env node
// Tests for the GitLab Issues adapter. Uses an injected spawnFn to mock
// glab calls — no subprocess actually runs.
// Run: node .claude/scripts/trackers/gitlab-issues.test.mjs
import { createTracker, AlreadyAssignedError } from './interface.mjs';

let failed = 0, passed = 0;
const ok = () => { passed++; };
const fail = (msg) => { failed++; console.error(`  FAIL: ${msg}`); };

// Build a spawnFn that returns canned responses keyed by argv.
function buildSpawn(responses) {
  const calls = [];
  const fn = (cmd, args, options) => {
    calls.push({ cmd, args: [...args], input: options?.input, env: options?.env });
    const key = args.join(' ');
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

const PROJECT = 'group/sub/proj';
const ME = JSON.stringify({ id: 1, username: 'alice' });

// An issue entity as `glab issue view -F json` prints it (raw GitLab API).
const issueEntity = (over = {}) => JSON.stringify({
  iid: 1, title: 'Fix bug', description: 'details', state: 'opened',
  assignees: [], labels: ['bug'], milestone: null,
  web_url: `https://gitlab.com/${PROJECT}/-/issues/1`,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  ...over,
});

// listAssignedToMe normalizes JSON into Issue[] with gl: ids.
{
  const spawnFn = buildSpawn({
    'api user': ME,
    [`issue list --repo ${PROJECT} --assignee alice -O json --per-page 100`]:
      `[${issueEntity({ iid: 1, assignees: [{ username: 'alice' }], milestone: { title: 'v0.1' } })}]`,
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const issues = await t.listAssignedToMe();
  if (issues.length === 1 && issues[0].id === 'gl:1' && issues[0].number === 1
      && issues[0].assignees[0] === 'alice' && issues[0].labels[0] === 'bug'
      && issues[0].milestone === 'v0.1' && issues[0].state === 'open') ok();
  else fail(`listAssignedToMe normalization wrong: ${JSON.stringify(issues)}`);
}

// listUnassigned filters out assigned issues client-side (GitLab has no
// no:assignee search).
{
  const spawnFn = buildSpawn({
    'api user': ME,
    [`issue list --repo ${PROJECT} -O json --per-page 100`]: JSON.stringify([
      JSON.parse(issueEntity({ iid: 2, assignees: [] })),
      JSON.parse(issueEntity({ iid: 3, assignees: [{ username: 'bob' }] })),
    ]),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const issues = await t.listUnassigned();
  if (issues.length === 1 && issues[0].id === 'gl:2' && issues[0].body === 'details') ok();
  else fail(`listUnassigned wrong: ${JSON.stringify(issues)}`);
}

// claim throws AlreadyAssignedError when a different user is assigned.
{
  const spawnFn = buildSpawn({
    'api user': ME,
    [`issue view 3 --repo ${PROJECT} -F json`]: issueEntity({ iid: 3, assignees: [{ username: 'bob' }] }),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  try { await t.claim('gl:3'); fail('claim should have thrown'); }
  catch (e) { if (e instanceof AlreadyAssignedError && e.assignees[0] === 'bob') ok(); else fail(`wrong error: ${e}`); }
}

// claim is idempotent when already assigned to me.
{
  const spawnFn = buildSpawn({
    'api user': ME,
    [`issue view 4 --repo ${PROJECT} -F json`]: issueEntity({ iid: 4, assignees: [{ username: 'alice' }] }),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const issue = await t.claim('gl:4');
  const updated = spawnFn.calls.some(c => c.args.includes('update') && c.args.includes('--assignee'));
  if (issue.id === 'gl:4' && !updated) ok();
  else fail(`claim should be no-op when already assigned: updated=${updated}`);
}

// claim assigns when unassigned, then re-reads the issue.
{
  const spawnFn = buildSpawn({
    'api user': ME,
    [`issue update 5 --repo ${PROJECT} --assignee alice`]: '',
    [`issue view 5 --repo ${PROJECT} -F json`]: () => {
      // The second view (after the update) reports alice assigned.
      const views = spawnFn.calls.filter(c => c.args[0] === 'issue' && c.args[1] === 'view');
      const entity = views.length === 1
        ? issueEntity({ iid: 5, assignees: [] })
        : issueEntity({ iid: 5, assignees: [{ username: 'alice' }] });
      return { status: 0, stdout: entity, stderr: '' };
    },
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const issue = await t.claim('gl:5');
  if (issue.assignees[0] === 'alice') ok();
  else fail(`claim should assign: ${JSON.stringify(issue)}`);
}

// createIssue parses the issue number from the URL glab prints.
{
  const spawnFn = buildSpawn({
    [`issue create --repo ${PROJECT} --title New --description b --yes --label chore`]:
      `https://gitlab.com/${PROJECT}/-/issues/99\n`,
    [`issue view 99 --repo ${PROJECT} -F json`]:
      issueEntity({ iid: 99, title: 'New', description: 'b', labels: ['chore'] }),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const issue = await t.createIssue({ title: 'New', body: 'b', labels: ['chore'] });
  if (issue.id === 'gl:99' && issue.labels[0] === 'chore') ok();
  else fail(`createIssue wrong: ${JSON.stringify(issue)}`);
}

// comment and closeIssue (with comment) build the right argv.
{
  const spawnFn = buildSpawn({
    [`issue note 5 --repo ${PROJECT} --message a note`]: '',
    [`issue close 5 --repo ${PROJECT}`]: '',
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  await t.comment('gl:5', 'a note');
  await t.closeIssue('gl:5', { comment: 'a note' });
  const notes = spawnFn.calls.filter(c => c.args[1] === 'note');
  const closes = spawnFn.calls.filter(c => c.args[1] === 'close');
  if (notes.length === 2 && closes.length === 1 && closes[0].args[2] === '5') ok();
  else fail(`comment/close argv wrong: ${JSON.stringify(spawnFn.calls.map(c => c.args))}`);
}

// ensureLabels creates only the missing labels, with #RRGGBB colors.
{
  const spawnFn = buildSpawn({
    [`label list --repo ${PROJECT} -F json --per-page 100`]: JSON.stringify([
      { name: 'bug', color: '#d73a4a' },
    ]),
    [`label create --repo ${PROJECT} --name feat --color #a2eeef`]: '',
    [`label create --repo ${PROJECT} --name chore --color #cfd3d7`]: '',
    [`label create --repo ${PROJECT} --name P1 --color #b60205`]: '',
    [`label create --repo ${PROJECT} --name P2 --color #fbca04`]: '',
    [`label create --repo ${PROJECT} --name P3 --color #0e8a16`]: '',
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  await t.ensureLabels();
  const created = spawnFn.calls.filter(c => c.args[1] === 'create').map(c => c.args[c.args.indexOf('--name') + 1]);
  if (JSON.stringify(created.sort()) === JSON.stringify(['P1', 'P2', 'P3', 'chore', 'feat'])) ok();
  else fail(`ensureLabels wrong: ${JSON.stringify(created)}`);
}

// ensureMilestone returns the existing milestone without creating.
{
  const spawnFn = buildSpawn({
    [`milestone list --repo ${PROJECT} -F json`]: JSON.stringify([
      { id: 1, title: 'Backlog', description: 'Triage later', state: 'active', due_date: null, web_url: 'https://x/milestones/1' },
    ]),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const ms = await t.ensureMilestone({ title: 'Backlog' });
  const created = spawnFn.calls.some(c => c.args[1] === 'create');
  if (ms.title === 'Backlog' && ms.number === 1 && ms.state === 'open' && !created) ok();
  else fail(`ensureMilestone should return existing without create: created=${created}, ms=${JSON.stringify(ms)}`);
}

// ensureMilestone creates when the title does not exist.
{
  const spawnFn = buildSpawn({
    [`milestone list --repo ${PROJECT} -F json`]: '[]',
    [`milestone create --repo ${PROJECT} --title v0.1 --description alpha --due-date 2026-06-01T00:00:00Z`]:
      JSON.stringify({ id: 2, title: 'v0.1', description: 'alpha', state: 'active', due_date: '2026-06-01', web_url: 'https://x/milestones/2' }),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const ms = await t.ensureMilestone({ title: 'v0.1', description: 'alpha', dueOn: '2026-06-01T00:00:00Z' });
  if (ms.title === 'v0.1' && ms.number === 2 && ms.dueOn === '2026-06-01') ok();
  else fail(`ensureMilestone should create when absent: ${JSON.stringify(ms)}`);
}

// ensureMilestone rejects a missing title.
{
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn: buildSpawn({}) });
  try { await t.ensureMilestone({}); fail('should have thrown'); }
  catch (e) { if (/title is required/.test(e.message)) ok(); else fail(`wrong error: ${e.message}`); }
}

// issueRef renders "#N" for the adapter's own project, the full
// group/sub/project#N path for any other MR project.
{
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn: buildSpawn({}) });
  if (t.issueRef('gl:42', { fromRepo: PROJECT }) === '#42'
      && t.issueRef('gl:42', { fromRepo: 'group/sub/other' }) === `${PROJECT}#42`
      && t.issueRef('gl:42') === '#42') ok();
  else fail(`issueRef shapes wrong: ${t.issueRef('gl:42', { fromRepo: 'group/sub/other' })}`);
  try { t.issueRef('not-an-id'); fail('issueRef should reject a non-gl id'); }
  catch (e) { if (/Not a GitLab issue ID/.test(e.message)) ok(); else fail(`wrong error: ${e.message}`); }
}

// glab failure surfaces stderr.
{
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'glab is on fire' });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  try { await t.listUnassigned(); fail('should have thrown'); }
  catch (e) { if (/glab is on fire/.test(e.message)) ok(); else fail(`wrong error: ${e.message}`); }
}

console.log('# repo resolution and self-managed host');

// A repo literal needs no git call; 'auto' parses any URL shape with
// nested groups, and the configured host is honoured + passed as
// GITLAB_HOST.
{
  const t = createTracker({ type: 'gitlab-issues', repo: 'explicit/sub/repo' }, { spawnFn: buildSpawn({}) });
  if (t.identity === 'gitlab-issues:explicit/sub/repo') ok();
  else fail(`explicit repo wrong: ${t.identity}`);

  for (const [url, expected] of [
    ['git@gitlab.com:group/sub/proj.git\n', PROJECT],
    ['https://gitlab.com/group/sub/proj\n', PROJECT],
    ['ssh://git@gitlab.com/group/proj.git\n', 'group/proj'],
  ]) {
    const spawnFn = buildSpawn({ 'remote get-url origin': url });
    const tracker = createTracker({ type: 'gitlab-issues' }, { spawnFn });
    if (tracker.identity === `gitlab-issues:${expected}`) ok();
    else fail(`auto-resolve ${url.trim()} wrong: ${tracker.identity}`);
  }

  const spawnFn = buildSpawn({
    'remote get-url origin': 'git@gitlab.example.com:acme/team/app.git\n',
    'api user --hostname gitlab.example.com': ME,
    'issue list --repo acme/team/app --assignee alice -O json --per-page 100': '[]',
  });
  const tracker = createTracker({ type: 'gitlab-issues', host: 'gitlab.example.com' }, { spawnFn });
  if (tracker.identity === 'gitlab-issues:acme/team/app') ok();
  else fail(`self-managed identity wrong: ${tracker.identity}`);
  await tracker.listAssignedToMe();
  const list = spawnFn.calls.find(c => c.args.includes('list'));
  if (list?.env?.GITLAB_HOST === 'gitlab.example.com') ok();
  else fail(`GITLAB_HOST not set: ${JSON.stringify(list?.env)}`);
  const api = spawnFn.calls.find(c => c.args[0] === 'api');
  if (api?.args.includes('--hostname')) ok();
  else fail(`--hostname not passed to glab api: ${api?.args.join(' ')}`);
}

// An origin on an unconfigured host is a construction error.
{
  const spawnFn = buildSpawn({ 'remote get-url origin': 'git@gitlab.example.com:acme/app.git\n' });
  let threw = null;
  try { createTracker({ type: 'gitlab-issues' }, { spawnFn }); } catch (e) { threw = e; }
  if (threw && /Cannot parse GitLab remote/.test(threw.message)) ok();
  else fail(`unconfigured host wrong: ${threw?.message ?? 'no throw'}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
