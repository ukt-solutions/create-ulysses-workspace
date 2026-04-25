#!/usr/bin/env node
// Unit tests for freshness.mjs
// Run: node template/.claude/lib/freshness.test.mjs
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

function fakeFetchOk(version) {
  return async () => ({ ok: true, json: async () => ({ version }) });
}

const fakeFetchErr = async () => { throw new Error('offline'); };

console.log('# refreshIfStale');

// Outdated workspace, fresh fetch, banner written
{
  const root = setupWorkspace({ templateVersion: '0.13.0' });
  const result = await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchOk('0.14.0'),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.status, 'outdated', 'outdated status');
  assertEq(result.current, '0.13.0', 'current version reported');
  assertEq(result.latest, '0.14.0', 'latest version reported');
  assertEq(existsSync(join(root, 'local-only-template-freshness.md')), true, 'banner file created');
  const banner = readFileSync(join(root, 'local-only-template-freshness.md'), 'utf-8');
  assertEq(banner.includes('v0.13.0'), true, 'banner mentions current');
  assertEq(banner.includes('v0.14.0'), true, 'banner mentions latest');
  rmSync(root, { recursive: true, force: true });
}

// Up-to-date workspace, banner deleted if present
{
  const root = setupWorkspace({ templateVersion: '0.14.0' });
  // Pre-existing banner from when it was outdated
  writeFileSync(join(root, 'local-only-template-freshness.md'), '## stale banner');
  await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: fakeFetchOk('0.14.0'),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(existsSync(join(root, 'local-only-template-freshness.md')), false, 'banner deleted when current');
  rmSync(root, { recursive: true, force: true });
}

// Fresh cache, no fetch happens
{
  const root = setupWorkspace({
    templateVersion: '0.13.0',
    cache: { latestVersion: '0.14.0', checkedAt: '2026-04-24T20:00:00Z' },
  });
  let fetchCalled = false;
  await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: async () => { fetchCalled = true; return { ok: true, json: async () => ({ version: '0.14.0' }) }; },
    nowFn: () => new Date('2026-04-24T21:00:00Z'), // 1h after cache
  });
  assertEq(fetchCalled, false, 'fresh cache skips fetch');
  assertEq(existsSync(join(root, 'local-only-template-freshness.md')), true, 'banner still written from cache');
  rmSync(root, { recursive: true, force: true });
}

// Stale cache triggers fetch
{
  const root = setupWorkspace({
    templateVersion: '0.13.0',
    cache: { latestVersion: '0.13.5', checkedAt: '2026-04-20T20:00:00Z' },
  });
  let fetchCalled = false;
  await refreshIfStale({
    workspaceRoot: root,
    ttlMs: 86400000,
    fetchFn: async () => { fetchCalled = true; return { ok: true, json: async () => ({ version: '0.14.0' }) }; },
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(fetchCalled, true, 'stale cache triggers fetch');
  rmSync(root, { recursive: true, force: true });
}

// Stale cache + offline: keep cached value, return unknown only if no cache
{
  const root = setupWorkspace({
    templateVersion: '0.13.0',
    cache: { latestVersion: '0.13.9', checkedAt: '2026-04-20T20:00:00Z' },
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
    fetchFn: fakeFetchOk('0.14.0'),
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
    fetchFn: fakeFetchOk('0.14.0'),
    nowFn: () => new Date('2026-04-24T21:00:00Z'),
  });
  assertEq(result.skipped, 'uninitialized', '0.0.0 treated as uninitialized');
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
