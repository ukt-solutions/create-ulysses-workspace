#!/usr/bin/env node
// Classify an upgrade payload's files against the workspace so /workspace-update
// can batch the safe cases and ask only where a decision is needed.
//
// Usage:
//   node classify-update.mjs [--root <dir>] [--payload <dir>]
//
// --root    workspace root; defaults to the current working directory (never
//           derived from this script's location — the upgrade payload runs
//           this file from <workspace>/.workspace-update/.claude/scripts/)
// --payload the staged payload; defaults to <root>/.workspace-update
//
// Prints JSON with five lists:
//   new       — no installed counterpart; safe to batch-apply after one confirm
//   identical — installed file already equals the payload byte-for-byte
//   differs   — installed file differs; needs a per-file decision
//   activated — the payload ships rules/{name}.md.skip while the workspace
//               deliberately keeps {name}.md active; nothing to install, the
//               active rule stays (gh:180)
//   removed   — installed file with no payload counterpart: the template
//               stopped shipping it. Excludes what the workspace owns:
//               *.test.mjs (the npm tarball does not ship tests, dev-checkout
//               installs do — every test file would otherwise read as
//               removed), anything gitignored (machine-local), paths under
//               .claude/worktrees/, and entries of workspace.json →
//               workspace.localFiles (array of .claude/-relative paths or
//               globs for files this workspace owns) (gh:180)
//
// Only verbatim-installed files are classified: everything under .claude/,
// plus .mcp.json and .claudeignore. The payload's templates (*.tmpl, which
// install with {{project-name}} substitution), _gitignore (merged line-by-line
// into the workspace's .gitignore), and .manifest.json (payload metadata) are
// handled by their own steps in /workspace-update and are excluded here.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitIgnoredPaths } from './build-workspace-context.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), payload: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--payload') args.payload = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

// Payload-relative paths that install verbatim at the same relative path.
// Everything else in the payload is a template or metadata handled elsewhere.
const VERBATIM_ROOTS = ['.claude', '.mcp.json', '.claudeignore'];

function isClassified(payloadRelPath) {
  const first = payloadRelPath.split('/')[0];
  return VERBATIM_ROOTS.includes(first);
}

// Directories never walked when looking for removed files. .claude/worktrees/
// holds entire nested worktrees — walking them is slow and every file inside
// is unmanaged by the template.
const SKIPPED_DIRS = new Set(['worktrees']);

function* walkFiles(dir, prefix = '', skipDirs = null) {
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (skipDirs && skipDirs.has(name)) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(full, rel, skipDirs);
    else if (st.isFile()) yield rel;
  }
}

// Installed files under the verbatim-managed roots: the .claude/ tree (minus
// skipped directories) plus the two standalone files. Nothing else in the
// workspace root is walked — repos/ and work-sessions/ hold entire worktrees
// the template never manages.
function* walkInstalledFiles(absRoot) {
  yield* walkFiles(join(absRoot, '.claude'), '.claude', SKIPPED_DIRS);
  for (const name of ['.mcp.json', '.claudeignore']) {
    if (existsSync(join(absRoot, name))) yield name;
  }
}

/** workspace.json → workspace.localFiles, normalized to .claude/-relative globs. */
function readLocalFiles(absRoot) {
  const configPath = join(absRoot, 'workspace.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const entries = config?.workspace?.localFiles;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e) => typeof e === 'string' && e.length > 0)
      .map((e) => e.replace(/^(\.claude\/)+/, ''));
  } catch {
    return [];
  }
}

/**
 * Match `rel` (a .claude/-relative posix path) against a localFiles entry —
 * an exact path or a glob where `**` spans separators and `*` does not.
 * No glob library: the shapes localFiles needs are these two stars.
 */
function globMatches(pattern, rel) {
  if (pattern === rel) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(
    `^${pattern.split('**').map(
      (part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
    ).join('.*')}$`,
  );
  return re.test(rel);
}

function isOwnedByWorkspace(rel, localFiles) {
  if (rel.endsWith('.test.mjs')) return true;
  // The template's own .gitignore declares these machine-local.
  if (rel === '.claude/settings.local.json' || rel === '.claude/.active-session.json') return true;
  if (!rel.startsWith('.claude/')) return false;
  const claudeRel = rel.slice('.claude/'.length);
  return localFiles.some((pattern) => globMatches(pattern, claudeRel));
}

export function classifyUpdate({ root, payload }) {
  const absRoot = resolve(root);
  const absPayload = resolve(payload ?? join(absRoot, '.workspace-update'));
  if (!existsSync(absPayload)) {
    throw new Error(`No payload found at ${absPayload} — run npx @ulysses-ai/create-workspace --upgrade first`);
  }

  const payloadFiles = [...walkFiles(absPayload)].filter(isClassified);
  const payloadSet = new Set(payloadFiles);

  const result = { new: [], identical: [], differs: [], activated: [], removed: [] };
  for (const rel of payloadFiles) {
    // A .skip rule whose active counterpart is installed was deliberately
    // activated by this workspace: report it as activated, not new.
    if (rel.startsWith('.claude/rules/') && rel.endsWith('.md.skip')) {
      const active = rel.replace(/\.skip$/, '');
      if (existsSync(join(absRoot, active)) && !existsSync(join(absRoot, rel))) {
        result.activated.push({ skip: rel, active });
        continue;
      }
    }
    const installed = join(absRoot, rel);
    if (!existsSync(installed)) {
      result.new.push(rel);
      continue;
    }
    const payloadBytes = readFileSync(join(absPayload, rel));
    const installedBytes = readFileSync(installed);
    if (Buffer.compare(payloadBytes, installedBytes) === 0) {
      result.identical.push(rel);
    } else {
      result.differs.push(rel);
    }
  }

  // Removed: installed verbatim-managed files with no payload counterpart.
  const skipSet = new Set(payloadFiles);
  const localFiles = readLocalFiles(absRoot);
  const installedFiles = [...walkInstalledFiles(absRoot)];
  const gitignored = gitIgnoredPaths(absRoot, installedFiles);
  for (const rel of installedFiles) {
    if (skipSet.has(rel)) continue;
    // An active rule whose .skip twin is in the payload is an activated rule,
    // not a removed one.
    if (rel.startsWith('.claude/rules/') && rel.endsWith('.md') && skipSet.has(`${rel}.skip`)) continue;
    if (gitignored.has(rel)) continue;
    if (isOwnedByWorkspace(rel, localFiles)) continue;
    result.removed.push(rel);
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  const result = classifyUpdate({ root: args.root, payload: args.payload });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`classify-update: ${err.message}\n`);
    process.exit(1);
  }
}
