import './require-node.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * SemVer 2.0 comparison limited to the formats this scaffolder publishes:
 * `x.y.z` and `x.y.z-prerelease.N`. Returns -1, 0, or 1.
 *
 * Rules:
 *   - Compare major, minor, patch numerically.
 *   - A pre-release version is older than the same x.y.z without a tag.
 *   - Pre-release identifiers compare per-identifier; numeric identifiers
 *     compare numerically (so `beta.10 > beta.2`), non-numeric lexically.
 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  const [aBase, aPre] = a.split('-', 2);
  const [bBase, bPre] = b.split('-', 2);
  const aParts = aBase.split('.').map(Number);
  const bParts = bBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((aParts[i] || 0) < (bParts[i] || 0)) return -1;
    if ((aParts[i] || 0) > (bParts[i] || 0)) return 1;
  }
  if (!aPre && !bPre) return 0;
  if (!aPre && bPre)  return 1;
  if (aPre && !bPre)  return -1;
  const aIds = aPre.split('.');
  const bIds = bPre.split('.');
  const len = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < len; i++) {
    const ai = aIds[i];
    const bi = bIds[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const an = Number(ai), bn = Number(bi);
      if (an < bn) return -1;
      if (an > bn) return 1;
    } else if (aNum && !bNum) {
      return -1;
    } else if (!aNum && bNum) {
      return 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  return 0;
}

const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@ulysses-ai/create-workspace/dist-tags';
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Which release channel an installed version rides: `stable` for a plain
 * `x.y.z`, otherwise the first pre-release identifier (`0.19.0-beta.3` →
 * `beta`). Returns null when the string isn't a version this scaffolder
 * publishes.
 */
export function channelOf(version) {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  if (!match) return null;
  return match[4] ? match[4].split('.')[0] : 'stable';
}

// The pre-release dist-tags an install is offered without comparing against
// them, by the channel it rides. A stable install compares against `latest`
// alone, so both pre-release tags are news to it. A beta install compares
// against `beta` itself, which leaves `rc` as the one tag ahead of it. An rc
// install is on the last stop before `latest` and is offered nothing.
const OFFERED_PRERELEASES = new Map([
  ['stable', ['beta', 'rc']],
  ['beta', ['rc']],
]);

/**
 * Pick the registry version an installed version should compare against,
 * given the package's dist-tags.
 *
 * A pre-release install tracks the highest semver among `latest` and its
 * own channel's tag, so a lagging `latest` (which has sat behind `beta`
 * for whole release cycles) never masks a newer build on the channel the
 * workspace actually rides. A stable install compares against `latest`
 * alone.
 *
 * On top of that version, the highest pre-release tag the install does not
 * compare against is returned separately when it outruns it: `beta` or
 * `rc` for a stable install, `rc` for a beta one. That is how a workspace on
 * the newest beta hears about `1.0.0-rc.0` without being told it is
 * outdated — `version`, and so the outdated-or-current decision, never
 * moves on account of a pre-release.
 *
 * Returns { version, channel, prerelease } — `version` is null when no
 * usable tag is present, and `prerelease` is null whenever `version` is:
 * with nothing to compare a pre-release against, there is nothing to offer.
 */
export function pickComparisonVersion(current, tags) {
  const channel = channelOf(current) || 'stable';
  const candidates = [];
  if (typeof tags?.latest === 'string') candidates.push(tags.latest);
  if (channel !== 'stable' && typeof tags?.[channel] === 'string') candidates.push(tags[channel]);
  let version = null;
  for (const candidate of candidates) {
    if (version === null || compareVersions(candidate, version) > 0) version = candidate;
  }
  let prerelease = null;
  if (version !== null) {
    for (const tag of OFFERED_PRERELEASES.get(channel) ?? []) {
      const candidate = tags[tag];
      if (typeof candidate !== 'string' || compareVersions(candidate, version) <= 0) continue;
      if (prerelease === null || compareVersions(candidate, prerelease) > 0) prerelease = candidate;
    }
  }
  return { version, channel, prerelease };
}

/**
 * Fetch the scaffolder's dist-tags from the npm registry and pick the
 * version to compare the installed `current` version against.
 * Returns { version, channel, tags, prerelease, error } — `error` is null
 * exactly when `version` is non-null, and the other fields are null on
 * failure. `tags` is the dist-tag map as published, `channel` is the
 * installed version's channel, and `prerelease` is the pre-release build
 * offered on top of `version` when one outruns it (see
 * pickComparisonVersion).
 *
 * Caller injects fetchFn for testing. Default uses global fetch (Node 18+).
 */
export async function getLatestVersion({ current = null, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const empty = { version: null, channel: null, tags: null, prerelease: null };
  try {
    const res = await fetchFn(DIST_TAGS_URL, { signal: controller.signal });
    if (!res.ok) {
      return { ...empty, error: `registry returned ${res.status} ${res.statusText || ''}`.trim() };
    }
    const body = await res.json();
    const tags = {};
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [tag, value] of Object.entries(body)) {
        if (typeof value === 'string') tags[tag] = value;
      }
    }
    const picked = pickComparisonVersion(current, tags);
    if (!picked.version) {
      return { ...empty, error: 'registry response missing dist-tags' };
    }
    return { version: picked.version, channel: picked.channel, tags, prerelease: picked.prerelease, error: null };
  } catch (err) {
    return { ...empty, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the version cache file. Returns the parsed object if it has a
 * `tags` object holding at least one string dist-tag; otherwise null.
 * Treats missing file, malformed JSON, and shape mismatches (including
 * caches written before dist-tag support, which had a bare `latestVersion`)
 * all as "no cache" — the next fetch rewrites the file in the new shape.
 */
export function readCache(path) {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (!data.tags || typeof data.tags !== 'object' || Array.isArray(data.tags)) return null;
    if (!Object.values(data.tags).some((v) => typeof v === 'string')) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write the version cache file, creating parent directories as needed.
 */
export function writeCache(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
