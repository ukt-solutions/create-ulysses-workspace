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

// listAssignedToMe normalizes JSON into Issue[] with gl: ids. (The api
// call always carries --hostname, even for gitlab.com.)
{
  const spawnFn = buildSpawn({
    'api user --hostname gitlab.com': ME,
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

// The paged api walks every list the adapters make.
const apiPage = (path, params, page) =>
  `api projects/${encodeURIComponent(PROJECT)}/${path}?${[...params, 'per_page=100', `page=${page}`].join('&')} --hostname gitlab.com`;

// listUnassigned uses the API's server-side assignee_id=None filter —
// not a client-side filter over `issue list`'s first page.
{
  const spawnFn = buildSpawn({
    [apiPage('issues', ['state=opened', 'assignee_id=None'], 1)]:
      JSON.stringify([JSON.parse(issueEntity({ iid: 2, assignees: [] }))]),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const issues = await t.listUnassigned();
  if (issues.length === 1 && issues[0].id === 'gl:2' && issues[0].body === 'details') ok();
  else fail(`listUnassigned wrong: ${JSON.stringify(issues)}`);
  const call = spawnFn.calls[0].args.join(' ');
  if (/assignee_id=None/.test(call) && !spawnFn.calls.some((c) => c.args[1] === 'list')) ok();
  else fail(`listUnassigned should filter server-side: ${call}`);
}

// The unassigned walk pages to the end — a full first page is not the
// whole list.
{
  const spawnFn = buildSpawn({
    [apiPage('issues', ['state=opened', 'assignee_id=None'], 1)]:
      JSON.stringify(Array.from({ length: 100 }, (_, i) => JSON.parse(issueEntity({ iid: i + 1 })))),
    [apiPage('issues', ['state=opened', 'assignee_id=None'], 2)]:
      JSON.stringify([JSON.parse(issueEntity({ iid: 101 }))]),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const issues = await t.listUnassigned();
  if (issues.length === 101 && issues[100].id === 'gl:101') ok();
  else fail(`listUnassigned pagination wrong: ${issues.length} issues`);
}

// claim throws AlreadyAssignedError when a different user is assigned.
{
  const spawnFn = buildSpawn({
    'api user --hostname gitlab.com': ME,
    [`issue view 3 --repo ${PROJECT} -F json`]: issueEntity({ iid: 3, assignees: [{ username: 'bob' }] }),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  try { await t.claim('gl:3'); fail('claim should have thrown'); }
  catch (e) { if (e instanceof AlreadyAssignedError && e.assignees[0] === 'bob') ok(); else fail(`wrong error: ${e}`); }
}

// claim is idempotent when already assigned to me.
{
  const spawnFn = buildSpawn({
    'api user --hostname gitlab.com': ME,
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
    'api user --hostname gitlab.com': ME,
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

// createIssue parses the issue number from the URL glab prints — the
// legacy /-/issues/N form...
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

// ...and the /-/work_items/N URLs GitLab now prints — same iid, so the
// follow-up `issue view` still finds it.
{
  const spawnFn = buildSpawn({
    [`issue create --repo ${PROJECT} --title New --description b --yes --label chore`]:
      `https://gitlab.com/${PROJECT}/-/work_items/99\n`,
    [`issue view 99 --repo ${PROJECT} -F json`]:
      issueEntity({ iid: 99, title: 'New', description: 'b', labels: ['chore'] }),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const issue = await t.createIssue({ title: 'New', body: 'b', labels: ['chore'] });
  if (issue.id === 'gl:99' && issue.title === 'New') ok();
  else fail(`createIssue work_items URL wrong: ${JSON.stringify(issue)}`);
}

// When neither URL shape appears the issue was still created — the error
// must say so, warn against retrying (a retry duplicates it), and carry
// glab's output so the issue can be found by hand.
{
  const spawnFn = buildSpawn({
    [`issue create --repo ${PROJECT} --title New --description b --yes`]:
      'something happened, but no URL\n',
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  try {
    await t.createIssue({ title: 'New', body: 'b' });
    fail('createIssue should have thrown on unparseable output');
  } catch (e) {
    const msg = e.message;
    if (/WAS created/.test(msg) && /duplicate/.test(msg) && /no URL/.test(msg)) ok();
    else fail(`wrong error for unparseable output: ${msg}`);
  }
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

// ensureMilestone returns the existing milestone without creating — and
// the list walks pages, so a milestone past the first hundred is still
// found.
{
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: `m${i + 1}`, description: '', state: 'active', due_date: null, web_url: 'u' }));
  const spawnFn = buildSpawn({
    [apiPage('milestones', [], 1)]: JSON.stringify(page1),
    [apiPage('milestones', [], 2)]: JSON.stringify([
      { id: 101, title: 'Backlog', description: 'Triage later', state: 'active', due_date: null, web_url: 'https://x/milestones/101' },
    ]),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const ms = await t.ensureMilestone({ title: 'Backlog' });
  const created = spawnFn.calls.some(c => c.args[1] === 'create');
  if (ms.title === 'Backlog' && ms.number === 101 && ms.state === 'open' && !created) ok();
  else fail(`ensureMilestone should page to the existing one: created=${created}, ms=${JSON.stringify(ms)}`);
}

// ensureMilestone creates when the title does not exist — and verifies by
// re-listing, since `glab milestone create` prints human text (no JSON
// flag exists).
{
  let created = false;
  const msList = () => JSON.stringify(created
    ? [{ id: 2, title: 'v0.1', description: 'alpha', state: 'active', due_date: '2026-06-01', web_url: 'https://x/milestones/2' }]
    : []);
  const spawnFn = buildSpawn({
    [apiPage('milestones', [], 1)]: () => ({ status: 0, stdout: msList(), stderr: '' }),
    [`milestone create --repo ${PROJECT} --title v0.1 --description alpha --due-date 2026-06-01T00:00:00Z`]:
      () => { created = true; return { status: 0, stdout: 'Created milestone v0.1', stderr: '' }; },
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const ms = await t.ensureMilestone({ title: 'v0.1', description: 'alpha', dueOn: '2026-06-01T00:00:00Z' });
  if (ms.title === 'v0.1' && ms.number === 2 && ms.dueOn === '2026-06-01') ok();
  else fail(`ensureMilestone should create when absent: ${JSON.stringify(ms)}`);
  const lists = spawnFn.calls.filter(c => c.args[0] === 'api').length;
  if (lists === 2) ok(); // before create and after, to verify
  else fail(`ensureMilestone should verify by re-listing: ${lists} api calls`);
}

// ensureMilestone rejects a missing title.
{
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn: buildSpawn({}) });
  try { await t.ensureMilestone({}); fail('should have thrown'); }
  catch (e) { if (/title is required/.test(e.message)) ok(); else fail(`wrong error: ${e.message}`); }
}

// issueRef renders "#N" for the adapter's own project, the full
// group/sub/project#N path for any other MR project; issueUrl mints the
// canonical URL a cross-forge reference needs.
{
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn: buildSpawn({}) });
  if (t.issueRef('gl:42', { fromRepo: PROJECT }) === '#42'
      && t.issueRef('gl:42', { fromRepo: 'group/sub/other' }) === `${PROJECT}#42`
      && t.issueRef('gl:42') === '#42') ok();
  else fail(`issueRef shapes wrong: ${t.issueRef('gl:42', { fromRepo: 'group/sub/other' })}`);
  if (t.issueUrl('gl:42') === `https://gitlab.com/${PROJECT}/-/issues/42`) ok();
  else fail(`issueUrl wrong: ${t.issueUrl('gl:42')}`);
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

// An exported GITLAB_HOST for some other instance never leaks into a
// gitlab.com tracker run — the adapter always names its own host.
{
  const spawnFn = buildSpawn({
    'api user --hostname gitlab.com': ME,
    [`issue list --repo ${PROJECT} --assignee alice -O json --per-page 100`]: '[]',
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const prev = process.env.GITLAB_HOST;
  process.env.GITLAB_HOST = 'elsewhere.example.com';
  try {
    await t.listAssignedToMe();
    const list = spawnFn.calls.find((c) => c.args.includes('list'));
    if (list?.env?.GITLAB_HOST === 'gitlab.com') ok();
    else fail(`foreign GITLAB_HOST leaked: ${JSON.stringify(list?.env?.GITLAB_HOST)}`);
  } finally {
    if (prev === undefined) delete process.env.GITLAB_HOST;
    else process.env.GITLAB_HOST = prev;
  }
}

// An origin on an unconfigured host is a construction error.
{
  const spawnFn = buildSpawn({ 'remote get-url origin': 'git@gitlab.example.com:acme/app.git\n' });
  let threw = null;
  try { createTracker({ type: 'gitlab-issues' }, { spawnFn }); } catch (e) { threw = e; }
  if (threw && /Cannot parse GitLab remote/.test(threw.message)) ok();
  else fail(`unconfigured host wrong: ${threw?.message ?? 'no throw'}`);
}

// ---- Epics (gh:195) ----
// Label mode and native mode. PROJECT is group/sub/proj, so native epics
// live at group "group/sub".

const GROUP = 'group/sub';
const groupApiPage = (path, params = [], page = 1) =>
  `api groups/${encodeURIComponent(GROUP)}/${path}?${[...params, 'per_page=100', `page=${page}`].join('&')} --hostname gitlab.com`;
const epicEntity = (over = {}) => JSON.stringify({
  id: 42, iid: 4, title: 'Auth', state: 'opened',
  web_url: `https://gitlab.com/groups/${GROUP}/-/epics/4`,
  ...over,
});
const PUT = (num, labels) =>
  `api projects/${encodeURIComponent(PROJECT)}/issues/${num} -X PUT -f labels=${labels} --hostname gitlab.com`;

// Label-mode listEpics walks the label list to the end — an epic past the
// first hundred labels is still found — and keeps only epic-prefixed names.
{
  const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `l${i}`, color: '#000000' }));
  page1[0] = { name: 'epic:auth', color: '#5319e7' };
  const spawnFn = buildSpawn({
    [apiPage('labels', [], 1)]: JSON.stringify(page1),
    [apiPage('labels', [], 2)]: JSON.stringify([{ name: 'epic:payments', color: '#5319e7' }, { name: 'bug', color: '#d73a4a' }]),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const epics = await t.listEpics();
  const none = await t.getEpic('nope');
  if (JSON.stringify(epics) === JSON.stringify([{ name: 'auth', native: false }, { name: 'payments', native: false }])
      && none === null) ok();
  else fail(`label-mode listEpics wrong: ${JSON.stringify(epics)} / ${none}`);
}

// Label-mode createEpic is idempotent (an existing label is never touched)
// and creates with the fixed colour and optional description.
{
  const spawnFn = buildSpawn({
    [apiPage('labels', [], 1)]: JSON.stringify([{ name: 'epic:auth', color: '#5319e7' }]),
    [`label create --repo ${PROJECT} --name epic:payments --color #5319e7 --description Q3 push`]: '',
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const existing = await t.createEpic({ name: 'auth' });
  const created = await t.createEpic({ name: 'payments', description: 'Q3 push' });
  const creates = spawnFn.calls.filter(c => c.args[1] === 'create').length;
  if (existing.native === false && created.native === false && created.name === 'payments' && creates === 1) ok();
  else fail(`label-mode createEpic wrong: creates=${creates}`);
}

// Label-mode setIssueEpic writes the final label set in one PUT — non-epic
// labels ride along, the old epic label drops, exactly one remains. Null
// strips; assigning the epic already carried (or clearing an epic-less
// issue) PUTs nothing; an unknown name throws before any write.
{
  const spawnFn = buildSpawn({
    [apiPage('labels', [], 1)]: JSON.stringify([{ name: 'epic:auth', color: '#5319e7' }]),
    [`issue view 5 --repo ${PROJECT} -F json`]: issueEntity({ iid: 5, id: 999, labels: ['bug', 'epic:old'] }),
    [PUT(5, 'bug,epic:auth')]: '',
    [`issue view 6 --repo ${PROJECT} -F json`]: issueEntity({ iid: 6, id: 996, labels: ['bug', 'epic:old'] }),
    [PUT(6, 'bug')]: '',
    [`issue view 7 --repo ${PROJECT} -F json`]: issueEntity({ iid: 7, id: 997, labels: ['bug', 'epic:auth'] }),
    [`issue view 8 --repo ${PROJECT} -F json`]: issueEntity({ iid: 8, id: 998, labels: ['bug'] }),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  await t.setIssueEpic('gl:5', 'auth');   // replace
  await t.setIssueEpic('gl:6', null);     // clear
  await t.setIssueEpic('gl:7', 'auth');   // already there → no-op
  await t.setIssueEpic('gl:8', null);     // nothing to clear → no-op
  const puts = spawnFn.calls.filter(c => c.args.includes('PUT')).map(c => c.args.join(' '));
  if (JSON.stringify(puts) === JSON.stringify([PUT(5, 'bug,epic:auth'), PUT(6, 'bug')])) ok();
  else fail(`label-mode setIssueEpic wrong: ${JSON.stringify(puts)}`);

  try { await t.setIssueEpic('gl:5', 'typo'); fail('unknown epic should have thrown'); }
  catch (e) {
    const wrote = spawnFn.calls.filter(c => c.args.includes('PUT')).length;
    if (/Unknown epic "typo"/.test(e.message) && wrote === 2) ok();
    else fail(`unknown-epic guard wrong (puts=${wrote}): ${e.message}`);
  }
}

// Label-mode listEpicIssues filters server-side by label and state (the API
// spells it "opened").
{
  const spawnFn = buildSpawn({
    [apiPage('labels', [], 1)]: JSON.stringify([{ name: 'epic:auth', color: '#5319e7' }]),
    [apiPage('issues', ['labels=epic%3Aauth', 'state=opened'], 1)]:
      `[${issueEntity({ iid: 9, labels: ['epic:auth'] })}]`,
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT }, { spawnFn });
  const issues = await t.listEpicIssues('auth');
  if (issues.length === 1 && issues[0].id === 'gl:9' && issues[0].labels[0] === 'epic:auth') ok();
  else fail(`label-mode listEpicIssues wrong: ${JSON.stringify(issues)}`);
  const firstApi = spawnFn.calls.find(c => c.args[0] === 'api' && c.args[1].includes('/issues')).args.join(' ');
  if (/labels=epic%3Aauth&state=opened/.test(firstApi)) ok();
  else fail(`label-mode listEpicIssues should filter server-side: ${firstApi}`);
}

// Native-mode listEpics walks the group's epics (group = project path minus
// last segment) and maps to Epic objects with the epic's iid as id.
{
  const spawnFn = buildSpawn({
    [groupApiPage('epics')]: `[${epicEntity()}]`,
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT, epics: 'native' }, { spawnFn });
  const epics = await t.listEpics();
  const auth = await t.getEpic('Auth');
  const none = await t.getEpic('Nope');
  if (epics.length === 1 && epics[0].name === 'Auth' && epics[0].id === 4 && epics[0].native === true
      && epics[0].url === `https://gitlab.com/groups/${GROUP}/-/epics/4`
      && auth?.name === 'Auth' && none === null) ok();
  else fail(`native listEpics wrong: ${JSON.stringify(epics)}`);
}

// Native-mode createEpic is idempotent and POSTs a title (+ description)
// epic when new.
{
  const spawnFn = buildSpawn({
    [groupApiPage('epics')]: `[${epicEntity()}]`,
    [`api groups/${encodeURIComponent(GROUP)}/epics -X POST -f title=Payments -f description=Q3 --hostname gitlab.com`]:
      epicEntity({ id: 43, iid: 5, title: 'Payments', web_url: `https://gitlab.com/groups/${GROUP}/-/epics/5` }),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT, epics: 'native' }, { spawnFn });
  const existing = await t.createEpic({ name: 'Auth' });
  const created = await t.createEpic({ name: 'Payments', description: 'Q3' });
  if (existing.id === 4 && created.id === 5 && created.native === true) ok();
  else fail(`native createEpic wrong: ${JSON.stringify(created)}`);
}

// Native-mode setIssueEpic POSTs the issue's global id to the epic — GitLab
// unassigns the previous epic server-side — and no-ops when it is already
// the issue's epic. Null unassigns via the association id from the epic's
// issue list; an epic-less issue clears with no api call at all.
{
  const assign = `api groups/${encodeURIComponent(GROUP)}/epics/4/issues/999 -X POST --hostname gitlab.com`;
  const spawnFn = buildSpawn({
    [groupApiPage('epics')]: `[${epicEntity()}]`,
    [`issue view 5 --repo ${PROJECT} -F json`]: issueEntity({ iid: 5, id: 999, epic: null, epic_iid: null }),
    [assign]: epicEntity({ id: 7, iid: null, epic_issue_id: 7 }),
    [`issue view 6 --repo ${PROJECT} -F json`]: issueEntity({ iid: 6, id: 996, epic: { id: 42, iid: 4, title: 'Auth' }, epic_iid: 4 }),
    [`issue view 7 --repo ${PROJECT} -F json`]: issueEntity({ iid: 7, id: 997, epic: { id: 42, iid: 4, title: 'Auth' }, epic_iid: 4 }),
    [groupApiPage('epics/4/issues')]:
      JSON.stringify([JSON.parse(issueEntity({ iid: 7, id: 997, epic_issue_id: 77 }))]),
    [`api groups/${encodeURIComponent(GROUP)}/epics/4/issues/77 -X DELETE --hostname gitlab.com`]: '',
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT, epics: 'native' }, { spawnFn });
  await t.setIssueEpic('gl:5', 'Auth'); // assign
  await t.setIssueEpic('gl:6', 'Auth'); // already there → no-op
  await t.setIssueEpic('gl:7', null);   // unassign via association id
  const posts = spawnFn.calls.filter(c => c.args.includes('POST')).length;
  const deletes = spawnFn.calls.filter(c => c.args.includes('DELETE')).map(c => c.args.join(' '));
  if (posts === 1 && JSON.stringify(deletes) === JSON.stringify([`api groups/${encodeURIComponent(GROUP)}/epics/4/issues/77 -X DELETE --hostname gitlab.com`])) ok();
  else fail(`native setIssueEpic wrong: posts=${posts}, deletes=${JSON.stringify(deletes)}`);

  // Clearing an issue with no epic issues no api call.
  const bare = buildSpawn({
    [groupApiPage('epics')]: `[${epicEntity()}]`,
    [`issue view 8 --repo ${PROJECT} -F json`]: issueEntity({ iid: 8, id: 998, epic: null, epic_iid: null }),
  });
  const t8 = createTracker({ type: 'gitlab-issues', repo: PROJECT, epics: 'native' }, { spawnFn: bare });
  await t8.setIssueEpic('gl:8', null);
  const apiCalls = bare.calls.filter(c => c.args[0] === 'api' && c.args[1].startsWith('groups')).length;
  if (apiCalls === 0) ok();
  else fail(`clearing an epic-less issue made ${apiCalls} group api calls`);
}

// Native-mode listEpicIssues walks the epic's issue list and filters state
// client-side (the endpoint has no state filter).
{
  const spawnFn = buildSpawn({
    [groupApiPage('epics')]: `[${epicEntity()}]`,
    [groupApiPage('epics/4/issues')]: `[${issueEntity({ iid: 9 })},${issueEntity({ iid: 10, state: 'closed' })}]`,
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT, epics: 'native' }, { spawnFn });
  const open = await t.listEpicIssues('Auth');
  const all = await t.listEpicIssues('Auth', { state: 'all' });
  if (open.length === 1 && open[0].id === 'gl:9' && all.length === 2) ok();
  else fail(`native listEpicIssues wrong: open=${open.length}, all=${all.length}`);
}

// A 403 from the group-epic endpoints — no Premium/Ultimate — surfaces as a
// clear error pointing at label mode, never a silent fallback.
{
  const spawnFn = buildSpawn({
    [groupApiPage('epics')]: () => ({
      status: 1, stdout: '',
      stderr: 'GET https://gitlab.com/api/v4/groups/group%2Fsub/epics: 403, Message: 403 Forbidden - Group epic NOT Found',
    }),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT, epics: 'native' }, { spawnFn });
  try { await t.listEpics(); fail('native 403 should have thrown'); }
  catch (e) {
    if (/native epics are unavailable/.test(e.message) && /403/.test(e.message)
        && /"label"/.test(e.message) && /epic:/.test(e.message)) ok();
    else fail(`403 translation wrong: ${e.message}`);
  }
}

// Native mode with a single-segment project path cannot derive a group —
// epics live at the group level, so that's an explicit error, not a guess.
{
  const t = createTracker({ type: 'gitlab-issues', repo: 'proj', epics: 'native' }, { spawnFn: buildSpawn({}) });
  try { await t.listEpics(); fail('single-segment native should have thrown'); }
  catch (e) { if (/cannot derive a group/.test(e.message)) ok(); else fail(`group-derivation error wrong: ${e.message}`); }
}

// epicLabelPrefix is configurable in label mode.
{
  const spawnFn = buildSpawn({
    [apiPage('labels', [], 1)]: JSON.stringify([{ name: 'epic:legacy' }, { name: 'E:auth' }]),
  });
  const t = createTracker({ type: 'gitlab-issues', repo: PROJECT, epicLabelPrefix: 'E:' }, { spawnFn });
  const epics = await t.listEpics();
  if (epics.length === 1 && epics[0].name === 'auth') ok();
  else fail(`custom epicLabelPrefix wrong: ${JSON.stringify(epics)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
