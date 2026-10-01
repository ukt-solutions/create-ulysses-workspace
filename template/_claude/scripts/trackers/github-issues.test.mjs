#!/usr/bin/env node
// Tests for the GitHub Issues adapter. Uses an injected spawnFn to mock gh calls.
// Run: node .claude/scripts/trackers/github-issues.test.mjs
import { createTracker, AlreadyAssignedError } from './interface.mjs';

let failed = 0, passed = 0;
const ok = () => { passed++; };
const fail = (msg) => { failed++; console.error(`  FAIL: ${msg}`); };

// Build a spawnFn that returns canned responses keyed by argv.
function buildSpawn(responses) {
  const calls = [];
  const fn = (cmd, args, options) => {
    calls.push({ cmd, args, input: options?.input });
    const key = args.join(' ');
    const resp = responses[key];
    if (!resp) {
      return { status: 1, stdout: '', stderr: `no mock for: ${cmd} ${key}` };
    }
    return { status: 0, stdout: resp, stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

// listAssignedToMe normalizes JSON into Issue[].
{
  const spawnFn = buildSpawn({
    'api user --jq .login': 'alice\n',
    'issue list --repo foo/bar --assignee alice --state open --json number,title,body,state,assignees,labels,milestone,url,createdAt,updatedAt':
      JSON.stringify([{ number: 1, title: 'Fix bug', body: 'details', state: 'OPEN', assignees: [{ login: 'alice' }], labels: [{ name: 'bug' }], milestone: { title: 'v0.1' }, url: 'https://github.com/foo/bar/issues/1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }]),
  });
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  const issues = await t.listAssignedToMe();
  if (issues.length === 1 && issues[0].id === 'gh:1' && issues[0].assignees[0] === 'alice'
      && issues[0].labels[0] === 'bug' && issues[0].milestone === 'v0.1') ok();
  else fail(`listAssignedToMe normalization wrong: ${JSON.stringify(issues)}`);
}

// listUnassigned uses no:assignee search.
{
  const spawnFn = buildSpawn({
    'api user --jq .login': 'alice\n',
    'issue list --repo foo/bar --search no:assignee --state open --json number,title,body,state,assignees,labels,milestone,url,createdAt,updatedAt':
      JSON.stringify([{ number: 2, title: 'Open work', body: '', state: 'OPEN', assignees: [], labels: [], milestone: null, url: 'https://github.com/foo/bar/issues/2', createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' }]),
  });
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  const issues = await t.listUnassigned();
  if (issues.length === 1 && issues[0].id === 'gh:2' && issues[0].assignees.length === 0) ok();
  else fail(`listUnassigned wrong: ${JSON.stringify(issues)}`);
}

// claim throws AlreadyAssignedError when a different user is assigned.
{
  const spawnFn = buildSpawn({
    'api user --jq .login': 'alice\n',
    'issue view 3 --repo foo/bar --json number,title,body,state,assignees,labels,milestone,url,createdAt,updatedAt':
      JSON.stringify({ number: 3, title: 't', body: '', state: 'OPEN', assignees: [{ login: 'bob' }], labels: [], milestone: null, url: 'u', createdAt: 'd', updatedAt: 'd' }),
  });
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  try { await t.claim('gh:3'); fail('claim should have thrown'); }
  catch (e) { if (e instanceof AlreadyAssignedError && e.assignees[0] === 'bob') ok(); else fail(`wrong error: ${e}`); }
}

// claim is idempotent when already assigned to me.
{
  const spawnFn = buildSpawn({
    'api user --jq .login': 'alice\n',
    'issue view 4 --repo foo/bar --json number,title,body,state,assignees,labels,milestone,url,createdAt,updatedAt':
      JSON.stringify({ number: 4, title: 't', body: '', state: 'OPEN', assignees: [{ login: 'alice' }], labels: [], milestone: null, url: 'u', createdAt: 'd', updatedAt: 'd' }),
  });
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  const issue = await t.claim('gh:4');
  const edited = spawnFn.calls.some(c => c.args.includes('edit') && c.args.includes('--add-assignee'));
  if (issue.id === 'gh:4' && !edited) ok();
  else fail(`claim should be no-op when already assigned: edited=${edited}`);
}

// claim assigns when unassigned.
{
  const viewResponse = JSON.stringify({ number: 5, title: 't', body: '', state: 'OPEN', assignees: [], labels: [], milestone: null, url: 'u', createdAt: 'd', updatedAt: 'd' });
  const viewAssigned = JSON.stringify({ number: 5, title: 't', body: '', state: 'OPEN', assignees: [{ login: 'alice' }], labels: [], milestone: null, url: 'u', createdAt: 'd', updatedAt: 'd' });
  let viewCallCount = 0;
  const spawnFn = (cmd, args, options) => {
    const key = args.join(' ');
    if (key === 'api user --jq .login') return { status: 0, stdout: 'alice\n', stderr: '' };
    if (key === 'issue view 5 --repo foo/bar --json number,title,body,state,assignees,labels,milestone,url,createdAt,updatedAt') {
      viewCallCount++;
      return { status: 0, stdout: viewCallCount === 1 ? viewResponse : viewAssigned, stderr: '' };
    }
    if (key === 'issue edit 5 --repo foo/bar --add-assignee alice') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: `no mock: ${key}` };
  };
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  const issue = await t.claim('gh:5');
  if (issue.assignees[0] === 'alice') ok();
  else fail(`claim should assign: ${JSON.stringify(issue)}`);
}

// createIssue parses issue number from URL.
{
  const spawnFn = (cmd, args, options) => {
    const key = args.join(' ');
    if (key.startsWith('issue create --repo foo/bar')) {
      return { status: 0, stdout: 'https://github.com/foo/bar/issues/99\n', stderr: '' };
    }
    if (key === 'issue view 99 --repo foo/bar --json number,title,body,state,assignees,labels,milestone,url,createdAt,updatedAt') {
      return { status: 0, stdout: JSON.stringify({ number: 99, title: 'New', body: 'b', state: 'OPEN', assignees: [], labels: [{ name: 'chore' }], milestone: null, url: 'https://github.com/foo/bar/issues/99', createdAt: 'd', updatedAt: 'd' }), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `no mock: ${key}` };
  };
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  const issue = await t.createIssue({ title: 'New', body: 'b', labels: ['chore'] });
  if (issue.id === 'gh:99') ok();
  else fail(`createIssue wrong: ${JSON.stringify(issue)}`);
}

// ensureLabels calls gh label create --force for each of the six standard labels.
{
  const created = [];
  const spawnFn = (cmd, args) => {
    if (args[0] === 'label' && args[1] === 'create') {
      created.push(args[2]);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'no mock' };
  };
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  await t.ensureLabels();
  const expected = ['bug', 'feat', 'chore', 'P1', 'P2', 'P3'];
  if (JSON.stringify(created.sort()) === JSON.stringify(expected.sort())) ok();
  else fail(`ensureLabels wrong: ${JSON.stringify(created)}`);
}

// gh failure surfaces stderr.
{
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'gh is on fire' });
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  try { await t.listUnassigned(); fail('should have thrown'); }
  catch (e) { if (/gh is on fire/.test(e.message)) ok(); else fail(`wrong error: ${e.message}`); }
}

// ensureMilestone returns existing milestone without POST when title matches.
{
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    if (key === 'api repos/foo/bar/milestones?state=all&per_page=100') {
      return { status: 0, stdout: JSON.stringify([
        { number: 1, title: 'Backlog', description: 'Triage later', state: 'open', due_on: null, html_url: 'https://github.com/foo/bar/milestone/1' },
      ]), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `no mock: ${key}` };
  };
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  const ms = await t.ensureMilestone({ title: 'Backlog' });
  const posted = calls.some(c => c.includes('-X POST'));
  if (ms.title === 'Backlog' && ms.number === 1 && !posted) ok();
  else fail(`ensureMilestone should return existing without POST: posted=${posted}, ms=${JSON.stringify(ms)}`);
}

// ensureMilestone creates when title does not exist.
{
  const spawnFn = (cmd, args) => {
    const key = args.join(' ');
    if (key === 'api repos/foo/bar/milestones?state=all&per_page=100') {
      return { status: 0, stdout: JSON.stringify([]), stderr: '' };
    }
    if (key.startsWith('api repos/foo/bar/milestones -X POST')) {
      return { status: 0, stdout: JSON.stringify({ number: 2, title: 'v0.1', description: 'alpha', state: 'open', due_on: null, html_url: 'https://github.com/foo/bar/milestone/2' }), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `no mock: ${key}` };
  };
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  const ms = await t.ensureMilestone({ title: 'v0.1', description: 'alpha' });
  if (ms.title === 'v0.1' && ms.number === 2 && ms.description === 'alpha') ok();
  else fail(`ensureMilestone should create when absent: ${JSON.stringify(ms)}`);
}

// ensureMilestone rejects missing title.
{
  const spawnFn = () => ({ status: 0, stdout: '[]', stderr: '' });
  const t = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn });
  try { await t.ensureMilestone({}); fail('should have thrown'); }
  catch (e) { if (/title is required/.test(e.message)) ok(); else fail(`wrong error: ${e.message}`); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
