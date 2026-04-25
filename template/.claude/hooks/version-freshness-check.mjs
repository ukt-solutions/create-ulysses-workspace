#!/usr/bin/env node
// SessionStart hook — refresh the template freshness banner if cache is stale.
// Gated on workspace.versionCheck.ambient (default true; will flip to false at v1.0).
// Always silent: surfaces only via the local-only-template-freshness.md banner,
// which CLAUDE.md includes via @ syntax. Never blocks session start.
import { getWorkspaceRoot, readJSON, respond } from './_utils.mjs';
import { refreshIfStale } from '../lib/freshness.mjs';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const root = getWorkspaceRoot(import.meta.url);
const config = readJSON(`${root}/workspace.json`);

// Default lifecycle: ambient=true during beta, missing-block fallback flips
// to false at v1.0 by editing this default.
const AMBIENT_DEFAULT = true;
const ambient = config?.workspace?.versionCheck?.ambient ?? AMBIENT_DEFAULT;

if (!ambient) {
  respond();
  process.exit(0);
}

try {
  await refreshIfStale({ workspaceRoot: root, ttlMs: TTL_MS });
} catch {
  // Hooks must never block session start. The banner reflects last-known
  // state; the user sees stale but never broken.
}
respond();
