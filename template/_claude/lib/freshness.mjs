import './require-node.mjs';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { compareVersions, getLatestVersion, readCache, writeCache } from './registry-check.mjs';

const BANNER_FILENAME = 'local-only-template-freshness.md';
const CACHE_FILENAME = '.version-check.json';

/**
 * Refresh the version cache if stale, then write or delete the banner file
 * based on a comparison of workspace.templateVersion to the latest npm version.
 *
 * Returns:
 *   { status: 'outdated', current, latest, checkedAt }
 *   { status: 'current',  current, latest, checkedAt }
 *   { status: 'unknown',  current, latest: null, checkedAt: null }
 *   { skipped: 'uninitialized' }
 *
 * Pure I/O is parameterized via fetchFn / nowFn for testability.
 */
export async function refreshIfStale({
  workspaceRoot,
  ttlMs,
  fetchFn = fetch,
  nowFn = () => new Date(),
}) {
  const wsConfigPath = join(workspaceRoot, 'workspace.json');
  let wsConfig;
  try {
    wsConfig = JSON.parse(readFileSync(wsConfigPath, 'utf-8'));
  } catch {
    return { skipped: 'no-workspace-json' };
  }
  const current = wsConfig?.workspace?.templateVersion;
  if (!current || current === '0.0.0') {
    return { skipped: 'uninitialized' };
  }

  const scratchpadDir = wsConfig?.workspace?.scratchpadDir || 'workspace-scratchpad';
  const cachePath = join(workspaceRoot, scratchpadDir, CACHE_FILENAME);
  const bannerPath = join(workspaceRoot, BANNER_FILENAME);

  let cache = readCache(cachePath);
  const now = nowFn();
  const cacheAgeMs = cache?.checkedAt ? now.getTime() - new Date(cache.checkedAt).getTime() : Infinity;
  const stale = cacheAgeMs > ttlMs;

  if (stale) {
    const fresh = await getLatestVersion({ fetchFn });
    if (fresh.version) {
      cache = { latestVersion: fresh.version, checkedAt: now.toISOString() };
      writeCache(cachePath, cache);
    }
    // On fetch error, keep whatever cache we already had (could be null).
  }

  if (!cache) {
    // No cache and offline (or fetch error). Leave banner alone — we have no
    // basis to write or delete it.
    return { status: 'unknown', current, latest: null, checkedAt: null };
  }

  const latest = cache.latestVersion;
  const cmp = compareVersions(current, latest);
  if (cmp < 0) {
    writeFileSync(
      bannerPath,
      `## Template update available\n\nYour workspace is on template v${current}; latest on npm is v${latest}.\nRun \`/maintenance\` for details or \`npx @ulysses-ai/create-workspace --upgrade\` to apply.\n`,
    );
    return { status: 'outdated', current, latest, checkedAt: cache.checkedAt };
  } else {
    if (existsSync(bannerPath)) unlinkSync(bannerPath);
    return { status: 'current', current, latest, checkedAt: cache.checkedAt };
  }
}
