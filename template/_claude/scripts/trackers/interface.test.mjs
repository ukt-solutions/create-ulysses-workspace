#!/usr/bin/env node
// Tests for the tracker factory and AlreadyAssignedError.
// Run: node .claude/scripts/trackers/interface.test.mjs
import { createTracker, AlreadyAssignedError, resolveEpicLabelPrefix } from './interface.mjs';

let failed = 0, passed = 0;
const ok = (msg) => { passed++; };
const fail = (msg) => { failed++; console.error(`  FAIL: ${msg}`); };

// AlreadyAssignedError carries assignees and a code.
{
  const err = new AlreadyAssignedError('gh:42', ['alice', 'bob']);
  if (err.code === 'ALREADY_ASSIGNED' && JSON.stringify(err.assignees) === '["alice","bob"]'
      && err.message.includes('gh:42') && err.message.includes('alice')) ok();
  else fail('AlreadyAssignedError should carry code and assignees');
}

// createTracker rejects missing config.
{
  try { createTracker(); fail('should throw on missing config'); }
  catch (e) { if (/No tracker configured/.test(e.message)) ok(); else fail(`wrong error: ${e.message}`); }
}

// createTracker rejects unknown type.
{
  try { createTracker({ type: 'nope' }); fail('should throw on unknown type'); }
  catch (e) { if (/Unknown tracker type/.test(e.message)) ok(); else fail(`wrong error: ${e.message}`); }
}

// createTracker builds a github-issues adapter without calling gh at construction (lazy).
{
  const fakeSpawn = () => { throw new Error('spawn should not run at construction'); };
  // With repo: 'foo/bar' literal, the adapter should NOT shell out to resolve the remote.
  const adapter = createTracker({ type: 'github-issues', repo: 'foo/bar' }, { spawnFn: fakeSpawn });
  if (adapter.identity === 'github-issues:foo/bar') ok();
  else fail(`unexpected identity: ${adapter.identity}`);
}

// createTracker builds a gitlab-issues adapter the same way (repo literal,
// no glab call at construction).
{
  const fakeSpawn = () => { throw new Error('spawn should not run at construction'); };
  const adapter = createTracker({ type: 'gitlab-issues', repo: 'group/sub/proj' }, { spawnFn: fakeSpawn });
  if (adapter.identity === 'gitlab-issues:group/sub/proj') ok();
  else fail(`unexpected identity: ${adapter.identity}`);
}

// Epic parity: every shipped adapter exposes the five epic methods — the
// contract comment in this module is the checklist (gh:195).
{
  const spawnFn = () => ({ status: 0, stdout: '[]', stderr: '' });
  for (const type of ['github-issues', 'gitlab-issues']) {
    const adapter = createTracker({ type, repo: 'foo/bar' }, { spawnFn });
    const missing = ['listEpics', 'getEpic', 'createEpic', 'setIssueEpic', 'listEpicIssues']
      .filter((m) => typeof adapter[m] !== 'function');
    if (missing.length === 0) ok();
    else fail(`${type} is missing epic methods: ${missing.join(', ')}`);
  }
}

// resolveEpicLabelPrefix defaults to "epic:", keeps any delimited custom
// prefix, and rejects one ending in an alphanumeric (it would slice epic
// names at an arbitrary character).
{
  if (resolveEpicLabelPrefix({}) === 'epic:'
      && resolveEpicLabelPrefix({ epicLabelPrefix: 'E:' }) === 'E:'
      && resolveEpicLabelPrefix({ epicLabelPrefix: 'epic::' }) === 'epic::') ok();
  else fail('resolveEpicLabelPrefix defaults/customs wrong');
  let threw = null;
  try { resolveEpicLabelPrefix({ epicLabelPrefix: 'epic' }); } catch (e) { threw = e; }
  if (threw && /must end with a delimiter/.test(threw.message)) ok();
  else fail(`bad prefix should throw: ${threw?.message ?? 'no throw'}`);
}

// The prefix validation reaches adapter construction.
{
  let threw = null;
  try { createTracker({ type: 'github-issues', repo: 'foo/bar', epicLabelPrefix: 'epic' }, { spawnFn: () => ({ status: 0, stdout: '', stderr: '' }) }); }
  catch (e) { threw = e; }
  if (threw && /must end with a delimiter/.test(threw.message)) ok();
  else fail(`bad prefix should throw at construction: ${threw?.message ?? 'no throw'}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
