#!/usr/bin/env node
// Tests for the forge interface module — factory dispatch and error types.
// Run: node .claude/scripts/forges/interface.test.mjs
import {
  createForge,
  ForgeError,
  PrNotFound,
  ReleaseNotFound,
  WorkflowNotFound,
  MergeRejected,
} from './interface.mjs';

let failed = 0, passed = 0;
const ok = () => { passed++; };
const fail = (msg) => { failed++; console.error(`  FAIL: ${msg}`); };

console.log('# error types');

// All forge errors descend from ForgeError so callers can catch broadly.
{
  const e = new PrNotFound('owner/repo#42');
  if (e instanceof ForgeError && e.code === 'PR_NOT_FOUND' && e.id === 'owner/repo#42') ok();
  else fail(`PrNotFound shape wrong: ${e.message} / code=${e.code} / id=${e.id}`);
}
{
  const e = new ReleaseNotFound('v1.2.3');
  if (e instanceof ForgeError && e.code === 'RELEASE_NOT_FOUND' && e.tag === 'v1.2.3') ok();
  else fail(`ReleaseNotFound shape wrong`);
}
{
  const e = new WorkflowNotFound({ runId: '123' });
  if (e instanceof ForgeError && e.code === 'WORKFLOW_NOT_FOUND') ok();
  else fail(`WorkflowNotFound shape wrong`);
}
{
  const e = new MergeRejected('owner/repo#1', 'required reviews missing');
  if (e instanceof ForgeError && e.code === 'MERGE_REJECTED' && /required reviews/.test(e.reason)) ok();
  else fail(`MergeRejected shape wrong`);
}

console.log('# createForge dispatch');

// Unset config defaults to github (back-compat for pre-forge-field workspaces).
{
  const noop = () => ({ status: 0, stdout: 'git@github.com:foo/bar.git\n', stderr: '' });
  const forge = createForge(undefined, { spawnFn: noop });
  if (forge.identity === 'github:foo/bar') ok();
  else fail(`Default-to-github failed: identity=${forge.identity}`);
}

// Explicit type: 'github' constructs an adapter.
{
  const noop = () => ({ status: 0, stdout: 'git@github.com:foo/bar.git\n', stderr: '' });
  const forge = createForge({ type: 'github', repo: 'baz/qux' }, { spawnFn: noop });
  if (forge.identity === 'github:baz/qux') ok();
  else fail(`Explicit github failed: identity=${forge.identity}`);
}

// Type: 'gitlab' throws NOT_IMPLEMENTED (stub) with a guidance pointer.
{
  let threw = null;
  try { createForge({ type: 'gitlab' }); } catch (e) { threw = e; }
  if (threw instanceof ForgeError && threw.code === 'NOT_IMPLEMENTED'
      && /github|glab/i.test(threw.message)) ok();
  else fail(`gitlab stub error wrong: ${threw?.message ?? 'did not throw'}`);
}

// Unknown type throws with a specific code.
{
  let threw = null;
  try { createForge({ type: 'bitbucket' }); } catch (e) { threw = e; }
  if (threw instanceof ForgeError && threw.code === 'UNKNOWN_TYPE'
      && /bitbucket/.test(threw.message)) ok();
  else fail(`Unknown type error wrong: ${threw?.message ?? 'did not throw'}`);
}

// Config: false means "explicitly disabled" — every call throws FORGE_DISABLED.
{
  let threw = null;
  try { createForge(false); } catch (e) { threw = e; }
  if (threw instanceof ForgeError && threw.code === 'FORGE_DISABLED') ok();
  else fail(`Disabled-config error wrong: ${threw?.message ?? 'did not throw'}`);
}

// Invalid config (non-object, non-false) is rejected with INVALID_CONFIG.
{
  let threw = null;
  try { createForge('github'); } catch (e) { threw = e; }
  if (threw instanceof ForgeError && threw.code === 'INVALID_CONFIG') ok();
  else fail(`Invalid-config error wrong: ${threw?.message ?? 'did not throw'}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
