#!/usr/bin/env node
// Tests for the tracker factory and AlreadyAssignedError.
// Run: node .claude/scripts/trackers/interface.test.mjs
import { createTracker, AlreadyAssignedError } from './interface.mjs';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
