#!/usr/bin/env node
// Measure the always-loaded context footprint of a workspace, and price a
// proposed addition before it is written.
//
// Every unconditional rule and every locked context file is a permanent tax on
// every session in this workspace — and, for anything shipped in the template,
// on every downstream workspace too. That cost is invisible at the moment
// someone decides where to put a durable fact, which is how the rules directory
// silently grew to 112 KB (gh:136, gh:138). This script makes the cost visible
// at the decision point. The `context-placement` skill and the
// `memory-guidance` rule both require running it before writing to an
// always-loaded destination.
//
// Reads only. Writes nothing. Makes no network calls.
//
// Usage:
//   node context-footprint.mjs --root <dir>
//   node context-footprint.mjs --root <dir> --json
//   node context-footprint.mjs --root <dir> --add <bytes> --as <destination>
//
// Destinations for --as: rule, rule-scoped, locked, shared, team-member,
// memory, skill, nowhere.

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

// A rough heuristic, not a tokenizer. Good enough to tell 200 bytes from 14 KB,
// which is the only distinction the placement decision actually turns on.
const BYTES_PER_TOKEN = 4;
const CONTEXT_WINDOW = 200000;

// Cost model per destination. Kept as data rather than a switch so the skill's
// routing table and this script cannot drift apart independently — the notes
// below are the same sentences the skill quotes.
const DESTINATIONS = {
  'rule': {
    alwaysLoadedCost: (n) => n,
    note: 'Unconditional rules load at launch at the same priority as CLAUDE.md, in every session — and in every downstream workspace that inherits the file.',
  },
  'rule-scoped': {
    alwaysLoadedCost: () => 0,
    note: 'A .claude/rules/*.md carrying a paths: array of globs loads only when Claude reads a matching file. Zero always-loaded cost.',
  },
  'locked': {
    alwaysLoadedCost: (n) => n,
    note: 'Locked files are concatenated verbatim into workspace-context/canonical.md, which every session loads in full.',
  },
  'shared': {
    alwaysLoadedCost: () => 120,
    note: 'Only the generated index line is always loaded; the body is read when the topic comes up.',
  },
  'team-member': {
    alwaysLoadedCost: () => 120,
    note: 'One index line, and only for that user — loaded via their gitignored CLAUDE.local.md.',
  },
  'memory': {
    alwaysLoadedCost: () => 100,
    note: 'One MEMORY.md pointer line is always loaded; the memory body is read on demand.',
  },
  'skill': {
    alwaysLoadedCost: () => 200,
    note: 'Only the frontmatter description is always loaded; the skill body loads when invoked.',
  },
  'nowhere': {
    alwaysLoadedCost: () => 0,
    note: 'Already covered elsewhere. The cheapest and most common correct answer.',
  },
};

function sizeOf(absPath) {
  try { return statSync(absPath).size; } catch { return null; }
}

function toPosix(p) {
  return p.split(sep).join('/');
}

/**
 * Follow @-imports out of `absFile`, depth-first.
 *
 * Imports resolve against the *importing file's* directory, not the workspace
 * root and emphatically not process.cwd() — a script that resolves against cwd
 * is how gh:142 happened. `visited` is keyed on the resolved absolute path so a
 * cycle (A imports B imports A) terminates and each file is counted once.
 */
function resolveImports(absFile, visited, missing) {
  const out = [];
  let text;
  try { text = readFileSync(absFile, 'utf8'); } catch { return out; }
  for (const rawLine of text.split(/\r?\n/)) {
    const m = /^@(\S+)$/.exec(rawLine.trim());
    if (!m) continue;
    const target = resolve(dirname(absFile), m[1]);
    if (visited.has(target)) continue;
    if (!existsSync(target)) {
      // A workspace may legitimately reference an optional file it does not
      // have (local-only-template-freshness.md, CODEBASE.md). Not an error —
      // but record it so the caller can see the reference is dangling.
      missing.push(m[1]);
      continue;
    }
    visited.add(target);
    out.push(target);
    out.push(...resolveImports(target, visited, missing));
  }
  return out;
}

function collectRules(absRoot) {
  const rulesDir = join(absRoot, '.claude', 'rules');
  if (!existsSync(rulesDir)) return [];
  return readdirSync(rulesDir)
    .filter((n) => n.endsWith('.md') && !n.endsWith('.md.skip'))
    .sort()
    .map((n) => join(rulesDir, n));
}

/**
 * Measure the always-loaded set under `root`.
 *
 * CLAUDE.local.md and anything it imports are reported separately under
 * `local`: they are per-user and gitignored, so folding them into the shared
 * total would overstate what the team actually pays.
 */
function measure({ root = '.' } = {}) {
  const absRoot = resolve(root);
  const files = [];
  const missingImports = [];

  const claudeMd = join(absRoot, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const visited = new Set([claudeMd]);
    files.push({ abs: claudeMd, kind: 'claude-md' });
    for (const imp of resolveImports(claudeMd, visited, missingImports)) {
      files.push({ abs: imp, kind: 'import' });
    }
  }

  for (const r of collectRules(absRoot)) files.push({ abs: r, kind: 'rule' });

  const entries = [];
  let totalBytes = 0;
  for (const f of files) {
    const bytes = sizeOf(f.abs);
    if (bytes === null) continue;
    totalBytes += bytes;
    entries.push({ path: toPosix(relative(absRoot, f.abs)), bytes, kind: f.kind });
  }
  entries.sort((a, b) => b.bytes - a.bytes);

  const localEntries = [];
  let localBytes = 0;
  const localMd = join(absRoot, 'CLAUDE.local.md');
  if (existsSync(localMd)) {
    const visited = new Set([localMd]);
    const localMissing = [];
    const localFiles = [localMd, ...resolveImports(localMd, visited, localMissing)];
    for (const abs of localFiles) {
      const bytes = sizeOf(abs);
      if (bytes === null) continue;
      localBytes += bytes;
      localEntries.push({ path: toPosix(relative(absRoot, abs)), bytes, kind: 'local' });
    }
    localEntries.sort((a, b) => b.bytes - a.bytes);
  }

  const totalTokens = Math.round(totalBytes / BYTES_PER_TOKEN);
  return {
    root: absRoot,
    totalBytes,
    totalTokens,
    percentOfWindow: Number(((totalTokens / CONTEXT_WINDOW) * 100).toFixed(1)),
    files: entries,
    missingImports,
    local: { totalBytes: localBytes, files: localEntries },
  };
}

function projectCost(measurement, addedBytes, destination) {
  const dest = DESTINATIONS[destination];
  if (!dest) throw new Error(`unknown destination: ${destination}`);
  const delta = dest.alwaysLoadedCost(addedBytes);
  const newTotalBytes = measurement.totalBytes + delta;
  const newTokens = Math.round(newTotalBytes / BYTES_PER_TOKEN);
  return {
    destination,
    addedBytes,
    alwaysLoadedDelta: delta,
    newTotalBytes,
    newPercentOfWindow: Number(((newTokens / CONTEXT_WINDOW) * 100).toFixed(1)),
    note: dest.note,
  };
}

function parseArgs(argv) {
  const args = { root: '.', json: false, add: null, as: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--root') { args.root = rest[++i]; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--add') { args.add = Number(rest[++i]); continue; }
    if (a === '--as') { args.as = rest[++i]; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  if (args.add !== null && args.as === null) {
    throw new Error('--add requires --as <destination>');
  }
  if (args.as !== null && args.add === null) {
    throw new Error('--as requires --add <bytes>');
  }
  if (args.add !== null && !Number.isFinite(args.add)) {
    throw new Error('--add expects a number of bytes');
  }
  if (args.as !== null && !DESTINATIONS[args.as]) {
    throw new Error(
      `unknown destination: ${args.as}. Valid: ${Object.keys(DESTINATIONS).join(', ')}`,
    );
  }
  return args;
}

function renderHuman(m, projection) {
  const lines = [];
  for (const f of m.files) {
    lines.push(`${String(f.bytes).padStart(7)}  ${f.kind.padEnd(9)}  ${f.path}`);
  }
  lines.push('-'.repeat(60));
  lines.push(
    `${String(m.totalBytes).padStart(7)}  TOTAL      ~${m.totalTokens} tokens, ` +
    `${m.percentOfWindow}% of a ${CONTEXT_WINDOW / 1000}k window`,
  );
  if (m.local.totalBytes > 0) {
    lines.push(`${String(m.local.totalBytes).padStart(7)}  local      (per-user, not counted above)`);
  }
  if (m.missingImports.length > 0) {
    lines.push(`         dangling @-imports: ${m.missingImports.join(', ')}`);
  }
  if (projection) {
    lines.push('');
    lines.push(
      `+${projection.addedBytes} B as "${projection.destination}" ` +
      `=> +${projection.alwaysLoadedDelta} B always-loaded`,
    );
    lines.push(
      `${m.totalBytes} B (${m.percentOfWindow}%) -> ` +
      `${projection.newTotalBytes} B (${projection.newPercentOfWindow}%)`,
    );
    lines.push(projection.note);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const m = measure({ root: args.root });
  const projection = args.add !== null ? projectCost(m, args.add, args.as) : null;
  if (args.json) {
    process.stdout.write(JSON.stringify({ ...m, projection }, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(m, projection) + '\n');
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`context-footprint: ${err.message}\n`);
    process.exit(2);
  }
}

export { measure, projectCost, parseArgs, resolveImports, DESTINATIONS, BYTES_PER_TOKEN, CONTEXT_WINDOW };
