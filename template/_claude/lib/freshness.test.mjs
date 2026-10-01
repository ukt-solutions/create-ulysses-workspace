#!/usr/bin/env node
// Unit tests for freshness.mjs
// Run: node template/_claude/lib/freshness.test.mjs
import { refreshIfStale } from './freshness.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

function setupWorkspace({ templateVersion, ambientBlock = '', cache = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'freshness-test-'));
  const wsConfig = {
    workspace: {
      name: 'test',
      scratchpadDir: 'workspace-scratchpad',
      templateVersion,
      ...(ambientBlock ? { versionCheck: { ambient: ambientBlock === 'on' } } : {}),
    },
    repos: {},
  };
  writeFileSync(join(root, 'workspace.json'), JSON.stringify(wsConfig));
  if (cache) {
    const cacheDir = join(root, 'workspace-scratchpad');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, '.version-check.json'), JSON.stringify(cache));
  }
  return root;
}

// Fake fetch that answers with a dist-tags body.
function fakeFetchTags(tags) {
  return async () => ({ ok: true, json: async () => tags });
}

const fakeFetchErr = async () => { throw new Error('offline'); };

console.log('# refreshIfStale');

// Outdated stable workspace, fresh fetch, banner written
{
  const root = setupWorkspace({ templateVersion: '0.13.0' });
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchTags({ latest: '0.14.0' }),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'outdated', 'outdated status');
  assertEq(result.current, '0.13.0', 'current version reported');
  assertEq(result.latest, '0.14.0', 'latest version reported');
  assertEq(existsSync(join(root, 'local-only-template-freshness.md')), true, 'banner file created');
  const banner = readFileSync(join(root, 'local-only-template-freshness.md'), 'utf-8');
  assertEq(banner.includes('v0.13.0'), true, 'banner mentions current');
  assertEq(banner.includes('v0.14.0'), true, 'banner mentions latest');
  const cacheFile = JSON.parse(readFileSync(join(root, 'workspace-scratchpad', '.version-check.json'), 'utf-8'));
  assertEq(cacheFile, { tags: { latest: '0.14.0' }, checkedAt: '2026-04-24T21:00:00.000Z' }, 'cache stores raw dist-tags');
  rmSync(root, { recursive: true, force: true });
}

// Beta workspace with stalled `latest` (the gh:171 bug): compares against beta
{
  const root = setupWorkspace({ templateVersion: '0.19.0-beta.0' });
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchTags({ latest: '0.13.0', beta: '0.19.0-beta.4' }),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'outdated', 'beta install outdated against beta tag');
  assertEq(result.latest, '0.19.0-beta.4', 'beta tag chosen over stalled latest');
  const banner = readFileSync(join(root, 'local-only-template-freshness.md'), 'utf-8');
  assertEq(banner.includes('v0.19.0-beta.4'), true, 'banner mentions newer beta');
  rmSync(root, { recursive: true, force: true });
}

// Beta workspace already on the beta tag, `latest` stalled behind it: current
{
  const root = setupWorkspace({ templateVersion: '0.19.0-beta.4' });
  writeFileSync(join(root, 'local-only-template-freshness.md'), '## stale banner');
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchTags({ latest: '0.13.0', beta: '0.19.0-beta.4' }),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'current', 'current beta not flagged outdated by stalled latest');
  assertEq(result.latest, '0.19.0-beta.4', 'beta tag used for comparison');
  assertEq(existsSync(join(root, 'local-only-template-freshness.md')), false, 'banner deleted');
  rmSync(root, { recursive: true, force: true });
}

// Beta workspace, `latest` is a higher stable: outdated against latest
{
  const root = setupWorkspace({ templateVersion: '0.19.0-beta.0' });
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchTags({ latest: '0.20.0', beta: '0.19.0-beta.4' }),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'outdated', 'beta install outdated against higher stable');
  assertEq(result.latest, '0.20.0', 'higher stable latest chosen');
  rmSync(root, { recursive: true, force: true });
}

// Stable workspace with newer beta available: current, prerelease reported, no banner
{
  const root = setupWorkspace({ templateVersion: '0.19.0' });
  writeFileSync(join(root, 'local-only-template-freshness.md'), '## stale banner');
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchTags({ latest: '0.19.0', beta: '0.20.0-beta.1' }),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'current', 'newer beta does not make stable install stale');
  assertEq(result.latest, '0.19.0', 'stable install compares against latest');
  assertEq(result.prerelease, '0.20.0-beta.1', 'newer beta reported as prerelease');
  assertEq(existsSync(join(root, 'local-only-template-freshness.md')), false, 'no banner for prerelease-only lead');
  rmSync(root, { recursive: true, force: true });
}

// Stable workspace with no beta lead: current, prerelease null
{
  const root = setupWorkspace({ templateVersion: '0.14.0' });
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchTags({ latest: '0.14.0' }),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'current', 'current status');
  assertEq(result.prerelease, null, 'no prerelease reported');
  rmSync(root, { recursive: true, force: true });
}

// Fresh cache, no fetch happens
{
  const root = setupWorkspace({
    templateVersion: '0.13.0',
    cache: { tags: { latest: '0.14.0' }, checkedAt: '2026-04-24T20:00:00Z' },
  });
  let fetchCalled = false;
  await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: async () => { fetchCalled = true; return { ok: true, json: async () => ({ latest: '0.14.0' }) }; },
    nowFn: () => new Date('2026-04-24T21:00:00Z'), // 1h after cache
  });
  assertEq(fetchCalled, false, 'fresh cache skips fetch');
  assertEq(existsSync(join(root, 'local-only-template-freshness.md')), true, 'banner still written from cache');
  rmSync(root, { recursive: true, force: true });
}

// Pre-dist-tag cache shape is treated as no cache: refetch and rewrite
{
  const root = setupWorkspace({
    templateVersion: '0.13.0',
    cache: { latestVersion: '0.14.0', checkedAt: '2026-04-24T20:00:00Z' },
  });
  let fetchCalled = false;
  await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: async () => { fetchCalled = true; return { ok: true, json: async () => ({ latest: '0.14.0' }) }; },
    nowFn: () => new Date('2026-04-24T21:00:00Z'), // cache would be fresh if the shape were accepted
  });
  assertEq(fetchCalled, true, 'legacy cache shape triggers refetch');
  const cacheFile = JSON.parse(readFileSync(join(root, 'workspace-scratchpad', '.version-check.json'), 'utf-8'));
  assertEq(cacheFile.tags, { latest: '0.14.0' }, 'cache rewritten in dist-tag shape');
  rmSync(root, { recursive: true, force: true });
}

// Stale cache triggers fetch
{
  const root = setupWorkspace({
    templateVersion: '0.13.0',
    cache: { tags: { latest: '0.13.5' }, checkedAt: '2026-04-20T20:00:00Z' },
  });
  let fetchCalled = false;
  await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: async () => { fetchCalled = true; return { ok: true, json: async () => ({ latest: '0.14.0' }) }; },
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(fetchCalled, true, 'stale cache triggers fetch');
  rmSync(root, { recursive: true, force: true });
}

// Cached beta tag still applies after an in-TTL upgrade from beta to stable
{
  const root = setupWorkspace({
    templateVersion: '0.20.0', // upgraded to stable inside the cache TTL
    cache: { tags: { latest: '0.20.0', beta: '0.21.0-beta.3' }, checkedAt: '2026-04-24T20:00:00Z' },
  });
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchErr,
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'current', 'stable install not compared against cached beta');
  assertEq(result.latest, '0.20.0', 'cached latest tag used for stable install');
  assertEq(result.prerelease, '0.21.0-beta.3', 'cached beta surfaced as prerelease');
  assertEq(existsSync(join(root, 'local-only-template-freshness.md')), false, 'no banner from channel mismatch');
  rmSync(root, { recursive: true, force: true });
}

// Stale cache + offline: keep cached tags, return unknown only if no cache
{
  const root = setupWorkspace({
    templateVersion: '0.13.0',
    cache: { tags: { latest: '0.13.9' }, checkedAt: '2026-04-20T20:00:00Z' },
  });
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchErr,
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'outdated', 'falls back to cached value when offline');
  assertEq(result.latest, '0.13.9', 'cached value used');
  rmSync(root, { recursive: true, force: true });
}

// No cache + offline: status unknown
{
  const root = setupWorkspace({ templateVersion: '0.13.0' });
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchErr,
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'unknown', 'unknown when no cache and offline');
  rmSync(root, { recursive: true, force: true });
}

// Uninitialized workspace (templateVersion missing)
{
  const root = mkdtempSync(join(tmpdir(), 'freshness-test-'));
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace: {}, repos: {} }));
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchTags({ latest: '0.14.0' }),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.skipped, 'uninitialized', 'uninitialized workspace skipped');
  rmSync(root, { recursive: true, force: true });
}

// templateVersion 0.0.0 treated as uninitialized
{
  const root = setupWorkspace({ templateVersion: '0.0.0' });
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchTags({ latest: '0.14.0' }),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.skipped, 'uninitialized', '0.0.0 treated as uninitialized');
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
