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

// Type: 'gitlab' constructs a GitLab adapter (repo literal, no git call).
{
  const spawnFn = (cmd, args) => ({ status: 1, stdout: '', stderr: `unexpected call: ${cmd} ${args.join(' ')}` });
  const forge = createForge({ type: 'gitlab', repo: 'group/sub/proj' }, { spawnFn });
  if (forge.identity === 'gitlab:group/sub/proj') ok();
  else fail(`gitlab dispatch failed: identity=${forge.identity}`);
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

console.log('# adapter selection by repo host (no explicit type)');

// A gitlab.com origin selects the GitLab adapter — this is what lets a
// workspace leave `type` unset and still mix hosts per repo.
{
  const spawnFn = () => ({ status: 0, stdout: 'git@gitlab.com:group/sub/proj.git\n', stderr: '' });
  const forge = createForge(undefined, { spawnFn });
  if (forge.identity === 'gitlab:group/sub/proj') ok();
  else fail(`gitlab-origin inference failed: identity=${forge.identity}`);
}

// The configured self-managed host selects the GitLab adapter too.
{
  const spawnFn = () => ({ status: 0, stdout: 'https://gitlab.example.com/acme/app.git\n', stderr: '' });
  const forge = createForge({ host: 'gitlab.example.com' }, { spawnFn });
  if (forge.identity === 'gitlab:acme/app') ok();
  else fail(`self-managed inference failed: identity=${forge.identity}`);
}

// An explicit repo slug carries no host — GitHub stays the default, and
// no git call is made to guess one.
{
  const spawnFn = (cmd, args) => ({ status: 1, stdout: '', stderr: `unexpected call: ${cmd} ${args.join(' ')}` });
  const forge = createForge({ repo: 'explicit/repo' }, { spawnFn });
  if (forge.identity === 'github:explicit/repo') ok();
  else fail(`explicit-repo default failed: identity=${forge.identity}`);
}

// An origin on an unrecognised host keeps the GitHub default; the github
// adapter then reports the unparseable remote itself.
{
  const spawnFn = () => ({ status: 0, stdout: 'git@bitbucket.org:acme/app.git\n', stderr: '' });
  let threw = null;
  try { createForge({}, { spawnFn }); } catch (e) { threw = e; }
  if (threw && /Cannot parse GitHub remote/.test(threw.message)) ok();
  else fail(`unknown-host default wrong: ${threw?.message ?? 'no throw'}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
