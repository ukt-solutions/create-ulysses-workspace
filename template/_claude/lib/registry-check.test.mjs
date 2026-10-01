#!/usr/bin/env node
// Unit tests for registry-check.mjs
// Run: node template/_claude/lib/registry-check.test.mjs
import { compareVersions } from './registry-check.mjs';

let failed = 0;
let passed = 0;

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

console.log('# compareVersions');
assertEq(compareVersions('0.13.0', '0.14.0'),               -1, 'older minor');
assertEq(compareVersions('0.14.0', '0.13.0'),                1, 'newer minor');
assertEq(compareVersions('0.13.0', '0.13.0'),                0, 'equal');
assertEq(compareVersions('1.0.0',  '0.99.99'),               1, 'newer major');
assertEq(compareVersions('0.14.0-beta.1', '0.14.0'),        -1, 'prerelease < release');
assertEq(compareVersions('0.14.0', '0.14.0-beta.1'),         1, 'release > prerelease');
assertEq(compareVersions('0.14.0-beta.1', '0.14.0-beta.2'), -1, 'prerelease numeric ordering');
assertEq(compareVersions('0.14.0-beta.10', '0.14.0-beta.2'), 1, 'prerelease numeric not lexical');
assertEq(compareVersions('0.14.0-beta.5', '0.14.0-beta.5'),  0, 'equal prerelease');
assertEq(compareVersions('0.14.0-alpha.1', '0.14.0-beta.1'),-1, 'alpha < beta lexical');

import { channelOf, pickComparisonVersion } from './registry-check.mjs';

console.log('\n# channelOf');
assertEq(channelOf('0.13.0'), 'stable', 'plain x.y.z is stable');
assertEq(channelOf('0.19.0-beta.0'), 'beta', 'beta prerelease is beta channel');
assertEq(channelOf('0.19.0-beta.10'), 'beta', 'beta prerelease number irrelevant');
assertEq(channelOf('0.2.0-rc.1'), 'rc', 'other prerelease tags name their channel');
assertEq(channelOf('banana'), null, 'non-version string is null');
assertEq(channelOf(null), null, 'null is null');
assertEq(channelOf('1.2.3.4'), null, 'four-component string is null');

console.log('\n# pickComparisonVersion');

// Beta install, `latest` stalled behind `beta` (the gh:171 scenario)
{
  const picked = pickComparisonVersion('0.19.0-beta.0', { latest: '0.13.0', beta: '0.19.0-beta.4' });
  assertEq(picked, { version: '0.19.0-beta.4', channel: 'beta', prerelease: null }, 'beta install picks newer beta over stalled latest');
}

// Beta install, `latest` is the higher stable
{
  const picked = pickComparisonVersion('0.19.0-beta.0', { latest: '0.20.0', beta: '0.19.0-beta.4' });
  assertEq(picked, { version: '0.20.0', channel: 'beta', prerelease: null }, 'beta install picks higher stable latest');
}

// Beta install exactly on the beta tag: not stale, no prerelease nag
{
  const picked = pickComparisonVersion('0.19.0-beta.4', { latest: '0.13.0', beta: '0.19.0-beta.4' });
  assertEq(picked, { version: '0.19.0-beta.4', channel: 'beta', prerelease: null }, 'current beta install compares to beta tag');
}

// Beta install, channel tag missing: falls back to latest (never reports lower-than-installed as newer)
{
  const picked = pickComparisonVersion('0.19.0-beta.0', { latest: '0.13.0' });
  assertEq(picked, { version: '0.13.0', channel: 'beta', prerelease: null }, 'missing channel tag falls back to latest');
}

// Stable install, newer beta exists: compare against latest, report beta separately
{
  const picked = pickComparisonVersion('0.19.0', { latest: '0.19.0', beta: '0.20.0-beta.1' });
  assertEq(picked, { version: '0.19.0', channel: 'stable', prerelease: '0.20.0-beta.1' }, 'stable install reports newer beta as prerelease');
}

// Stable install, beta is same-version prerelease: not a prerelease lead
{
  const picked = pickComparisonVersion('0.19.0', { latest: '0.19.0', beta: '0.19.0-beta.4' });
  assertEq(picked, { version: '0.19.0', channel: 'stable', prerelease: null }, 'same-x.y.z beta does not outrun stable latest');
}

// Stable install, no beta lead: plain latest comparison
{
  const picked = pickComparisonVersion('0.13.0', { latest: '0.14.0', beta: '0.13.1-beta.2' });
  assertEq(picked, { version: '0.14.0', channel: 'stable', prerelease: null }, 'stable install picks latest');
}

// No usable tags at all
assertEq(pickComparisonVersion('0.19.0', {}), { version: null, channel: 'stable', prerelease: null }, 'empty tags yield null version');
assertEq(pickComparisonVersion('0.19.0', null), { version: null, channel: 'stable', prerelease: null }, 'null tags yield null version');

import { getLatestVersion } from './registry-check.mjs';

console.log('\n# getLatestVersion');

// Helper: build a fake fetch that responds with a dist-tags body
function fakeFetch(body) {
  return async () => ({ ok: true, json: async () => body });
}

// Beta install, stale `latest` (the gh:171 bug): picks the newer beta
{
  const result = await getLatestVersion({
    current: '0.19.0-beta.0',
    fetchFn: fakeFetch({ latest: '0.13.0', beta: '0.19.0-beta.0' }),
  });
  assertEq(result, {
    version: '0.19.0-beta.0',
    channel: 'beta',
    tags: { latest: '0.13.0', beta: '0.19.0-beta.0' },
    prerelease: null,
    error: null,
  }, 'beta install with stale latest picks beta');
}

// Beta install, `latest` is a higher stable: picks latest
{
  const result = await getLatestVersion({
    current: '0.19.0-beta.0',
    fetchFn: fakeFetch({ latest: '0.20.0', beta: '0.19.0-beta.4' }),
  });
  assertEq(result, {
    version: '0.20.0',
    channel: 'beta',
    tags: { latest: '0.20.0', beta: '0.19.0-beta.4' },
    prerelease: null,
    error: null,
  }, 'beta install with higher stable latest picks latest');
}

// Stable install with newer beta: not stale, prerelease reported separately
{
  const result = await getLatestVersion({
    current: '0.19.0',
    fetchFn: fakeFetch({ latest: '0.19.0', beta: '0.20.0-beta.1' }),
  });
  assertEq(result, {
    version: '0.19.0',
    channel: 'stable',
    tags: { latest: '0.19.0', beta: '0.20.0-beta.1' },
    prerelease: '0.20.0-beta.1',
    error: null,
  }, 'stable install reports newer beta as prerelease');
}

// Plain stable success (backward-compatible shape)
{
  const result = await getLatestVersion({
    current: '0.13.0',
    fetchFn: fakeFetch({ latest: '0.14.0' }),
  });
  assertEq(result, {
    version: '0.14.0',
    channel: 'stable',
    tags: { latest: '0.14.0' },
    prerelease: null,
    error: null,
  }, 'stable success returns latest');
}

// Non-2xx response
{
  const fake404 = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
  const result = await getLatestVersion({ current: '0.19.0', fetchFn: fake404 });
  assertEq(result.version, null, 'non-2xx version is null');
  assertEq(typeof result.error, 'string', 'non-2xx returns error string');
}

// Malformed body (no dist-tags)
{
  const result = await getLatestVersion({ current: '0.19.0', fetchFn: fakeFetch({ name: 'foo' }) });
  assertEq(result, { version: null, channel: null, tags: null, prerelease: null, error: 'registry response missing dist-tags' }, 'body without dist-tags errors');
}

// Non-string junk in the body is dropped, not fatal
{
  const result = await getLatestVersion({
    current: '0.13.0',
    fetchFn: fakeFetch({ latest: '0.14.0', broken: 42, also: null }),
  });
  assertEq(result.tags, { latest: '0.14.0' }, 'non-string tag values filtered out');
}

// Network error (fetch throws)
{
  const fakeThrow = async () => { throw new Error('ECONNREFUSED'); };
  const result = await getLatestVersion({ current: '0.19.0', fetchFn: fakeThrow });
  assertEq(result.version, null, 'thrown error returns null version');
  assertEq(result.error.includes('ECONNREFUSED'), true, 'thrown error message preserved');
}

// Timeout: abort signal fires, fetch rejects, error returned
{
  const fakeHang = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
  });
  const result = await getLatestVersion({ current: '0.19.0', fetchFn: fakeHang, timeoutMs: 20 });
  assertEq(result.version, null, 'timeout version is null');
  assertEq(result.error.includes('aborted'), true, 'timeout error mentions abort');
}

import { readCache, writeCache } from './registry-check.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

console.log('\n# readCache / writeCache');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'reg-cache-test-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// readCache: missing file returns null
withTempDir((dir) => {
  const result = readCache(join(dir, 'missing.json'));
  assertEq(result, null, 'missing file returns null');
});

// readCache: malformed JSON returns null
withTempDir((dir) => {
  const path = join(dir, 'bad.json');
  writeFileSync(path, '{not json');
  const result = readCache(path);
  assertEq(result, null, 'malformed JSON returns null');
});

// readCache: valid file returns parsed object
withTempDir((dir) => {
  const path = join(dir, 'good.json');
  writeFileSync(path, JSON.stringify({ tags: { latest: '0.14.0', beta: '0.15.0-beta.1' }, checkedAt: '2026-04-24T21:00:00Z' }));
  const result = readCache(path);
  assertEq(result, { tags: { latest: '0.14.0', beta: '0.15.0-beta.1' }, checkedAt: '2026-04-24T21:00:00Z' }, 'valid file parsed');
});

// readCache: pre-dist-tag cache shape (bare latestVersion) is treated as no cache
withTempDir((dir) => {
  const path = join(dir, 'legacy.json');
  writeFileSync(path, JSON.stringify({ latestVersion: '0.14.0', checkedAt: '2026-04-24T21:00:00Z' }));
  const result = readCache(path);
  assertEq(result, null, 'legacy latestVersion-only cache rejected');
});

// readCache: missing required fields returns null
withTempDir((dir) => {
  const path = join(dir, 'partial.json');
  writeFileSync(path, JSON.stringify({ checkedAt: '2026-04-24T21:00:00Z' }));
  const result = readCache(path);
  assertEq(result, null, 'missing tags returns null');
});

// readCache: tags object with no string values returns null
withTempDir((dir) => {
  const path = join(dir, 'junk-tags.json');
  writeFileSync(path, JSON.stringify({ tags: { latest: 42 }, checkedAt: '2026-04-24T21:00:00Z' }));
  const result = readCache(path);
  assertEq(result, null, 'non-string tag values rejected');
});

// writeCache + readCache round-trip
withTempDir((dir) => {
  const path = join(dir, 'rt.json');
  writeCache(path, { tags: { latest: '0.14.0' }, checkedAt: '2026-04-24T21:00:00Z' });
  assertEq(readCache(path), { tags: { latest: '0.14.0' }, checkedAt: '2026-04-24T21:00:00Z' }, 'round-trip equal');
});

// writeCache creates parent dir if missing
withTempDir((dir) => {
  const path = join(dir, 'nested', 'deep', 'cache.json');
  writeCache(path, { tags: { latest: '0.14.0' }, checkedAt: '2026-04-24T21:00:00Z' });
  assertEq(readCache(path)?.tags?.latest, '0.14.0', 'parent dir created');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
