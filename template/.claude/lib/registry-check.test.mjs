#!/usr/bin/env node
// Unit tests for registry-check.mjs
// Run: node template/.claude/lib/registry-check.test.mjs
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

import { getLatestVersion } from './registry-check.mjs';

console.log('\n# getLatestVersion');

// Helper: build a fake fetch
function fakeFetch(response) {
  return async () => response;
}

// Success path
{
  const fakeOk = fakeFetch({
    ok: true,
    json: async () => ({ version: '0.14.0', name: '@ulysses-ai/create-workspace' }),
  });
  const result = await getLatestVersion({ fetchFn: fakeOk });
  assertEq(result, { version: '0.14.0', error: null }, 'success returns version');
}

// Non-2xx response
{
  const fake404 = fakeFetch({ ok: false, status: 404, statusText: 'Not Found' });
  const result = await getLatestVersion({ fetchFn: fake404 });
  assertEq(result.version, null, 'non-2xx version is null');
  assertEq(typeof result.error, 'string', 'non-2xx returns error string');
}

// Malformed body (no version field)
{
  const fakeBad = fakeFetch({ ok: true, json: async () => ({ name: 'foo' }) });
  const result = await getLatestVersion({ fetchFn: fakeBad });
  assertEq(result.version, null, 'missing version field is null');
  assertEq(typeof result.error, 'string', 'missing version returns error');
}

// Network error (fetch throws)
{
  const fakeThrow = async () => { throw new Error('ECONNREFUSED'); };
  const result = await getLatestVersion({ fetchFn: fakeThrow });
  assertEq(result.version, null, 'thrown error returns null version');
  assertEq(result.error.includes('ECONNREFUSED'), true, 'thrown error message preserved');
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
  writeFileSync(path, JSON.stringify({ latestVersion: '0.14.0', checkedAt: '2026-04-24T21:00:00Z' }));
  const result = readCache(path);
  assertEq(result, { latestVersion: '0.14.0', checkedAt: '2026-04-24T21:00:00Z' }, 'valid file parsed');
});

// readCache: missing required fields returns null
withTempDir((dir) => {
  const path = join(dir, 'partial.json');
  writeFileSync(path, JSON.stringify({ checkedAt: '2026-04-24T21:00:00Z' }));
  const result = readCache(path);
  assertEq(result, null, 'missing latestVersion returns null');
});

// writeCache + readCache round-trip
withTempDir((dir) => {
  const path = join(dir, 'rt.json');
  writeCache(path, { latestVersion: '0.14.0', checkedAt: '2026-04-24T21:00:00Z' });
  assertEq(readCache(path), { latestVersion: '0.14.0', checkedAt: '2026-04-24T21:00:00Z' }, 'round-trip equal');
});

// writeCache creates parent dir if missing
withTempDir((dir) => {
  const path = join(dir, 'nested', 'deep', 'cache.json');
  writeCache(path, { latestVersion: '0.14.0', checkedAt: '2026-04-24T21:00:00Z' });
  assertEq(readCache(path)?.latestVersion, '0.14.0', 'parent dir created');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
