#!/usr/bin/env node
// Template baseline: the sha256 of every verbatim-installed file the template
// last shipped, recorded at <root>/.claude/.template-baseline.json. It is the
// third input of /workspace-update's three-way classification (workspace vs
// payload vs baseline), so a file the template changed since the installed
// version reads as an update to apply in batch — not a local edit to negotiate
// file by file (gh:183).
//
// Shape:
//   { "templateVersion": "0.21.0",
//     "files": { ".claude/skills/workspace-update/SKILL.md": "<sha256>", … } }
// Keys are root-relative posix paths covering the verbatim-installed roots
// (.claude/**, .mcp.json, .claudeignore). The file is committed with the
// workspace — every machine that pulls gets the same template files, so it
// gets the same baseline.
//
// Written by `--init` scaffolding (lib/init.mjs), by /workspace-init once the
// remaining components are installed, and at the end of every /workspace-update
// (classify-update.mjs --write-baseline). Interactive scaffolding writes it
// from the template tree (lib/scaffold.mjs).
//
// The rule every entry follows: record the hash of the payload's content —
// what the template last shipped — never the workspace's on-disk bytes. A
// file the user kept despite a template change therefore keeps the PAYLOAD
// hash: the next update still sees workspace ≠ baseline and asks about the
// file, so a deliberate divergence is never silently adopted as the new
// baseline. The invariant that matters is the converse — a file the user
// never touched (workspace == baseline) is never reported as a local edit.
//
// Not covered: *.test.mjs (the tarball never ships them; a workspace's test
// files came from a dev checkout and age independently — classify-update
// reports them as staleTests instead), machine-local files
// (.claude/settings.local.json, .claude/.active-session.json), and anything
// under .claude/worktrees/.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const BASELINE_PATH = '.claude/.template-baseline.json';

// [source name, installed name] pairs for the verbatim-installed roots. The
// staged payload carries the live names; the template tree stores .claude/ and
// .mcp.json under the inert names _claude/ and _mcp.json, so scaffold passes
// the inert pairs.
export const LIVE_PAIRS = [
  ['.claude', '.claude'],
  ['.mcp.json', '.mcp.json'],
  ['.claudeignore', '.claudeignore'],
];
export const INERT_PAIRS = [
  ['_claude', '.claude'],
  ['_mcp.json', '.mcp.json'],
  ['.claudeignore', '.claudeignore'],
];

// Machine-local or per-workspace files that never belong in the baseline.
const OWNED_PATHS = new Set([
  '.claude/settings.local.json',
  '.claude/.active-session.json',
  BASELINE_PATH,
]);

// Entire nested worktrees live under .claude/worktrees/ — never walked.
const SKIP_DIRS = new Set(['worktrees']);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function* walkFiles(dir, prefix = '') {
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (prefix === '.claude' && SKIP_DIRS.has(name)) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(full, rel);
    else if (st.isFile()) yield rel;
  }
}

/**
 * Read the baseline at <root>/.claude/.template-baseline.json. Returns
 * { templateVersion, files } or null when absent (workspaces older than the
 * baseline's introduction) or unparseable — classification then falls back to
 * the two-way behavior rather than failing the update.
 */
export function readBaseline(root) {
  const path = join(resolve(root), BASELINE_PATH);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.files !== 'object' || parsed.files === null) {
      return null;
    }
    return { templateVersion: typeof parsed.templateVersion === 'string' ? parsed.templateVersion : null, files: parsed.files };
  } catch {
    return null;
  }
}

/**
 * Build a baseline from a template source directory (a staged payload with
 * live names, or the template tree via INERT_PAIRS). `version` overrides the
 * payload manifest's templateVersion — pass it when the source has no
 * .manifest.json (the template tree).
 */
export function buildBaseline(sourceDir, { pairs = LIVE_PAIRS, version = null } = {}) {
  const absSource = resolve(sourceDir);
  const files = {};
  for (const [sourceName, installedName] of pairs) {
    const src = join(absSource, sourceName);
    if (!existsSync(src)) continue;
    let st;
    try { st = statSync(src); } catch { continue; }
    if (st.isFile()) {
      if (!OWNED_PATHS.has(installedName) && !installedName.endsWith('.test.mjs')) {
        files[installedName] = sha256(readFileSync(src));
      }
      continue;
    }
    for (const rel of walkFiles(src, installedName)) {
      if (OWNED_PATHS.has(rel) || rel.endsWith('.test.mjs')) continue;
      files[rel] = sha256(readFileSync(join(absSource, sourceName, rel.slice(installedName.length + 1))));
    }
  }
  let templateVersion = version;
  if (templateVersion === null) {
    try {
      const manifest = JSON.parse(readFileSync(join(absSource, '.manifest.json'), 'utf8'));
      if (typeof manifest.templateVersion === 'string') templateVersion = manifest.templateVersion;
    } catch {
      // No manifest (or unreadable) — caller should pass `version`.
    }
  }
  return { templateVersion, files: Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]])) };
}

/**
 * Write the baseline for the workspace at `root`. Returns the written object.
 */
export function writeBaseline(root, sourceDir, opts = {}) {
  const baseline = buildBaseline(sourceDir, opts);
  const dest = join(resolve(root), BASELINE_PATH);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}
