#!/usr/bin/env node
// Measure the always-loaded context footprint of a workspace, price a proposed
// addition before it is written, and check the total against a budget.
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
// A rule whose frontmatter declares `paths:` is conditional — Claude Code loads
// it only when a file matching one of its globs is read — so it is listed under
// `conditional`, excluded from the total, and priced at zero by the
// `rule-scoped` destination.
//
// The budget is `workspace.alwaysLoadedBudgetBytes` from <root>/workspace.json
// (absent means no budget); `--budget <bytes>` overrides it. With a budget set,
// human output ends with a `BUDGET <total>/<budget> bytes — ok|OVER` line, JSON
// gains `budget` and `overBudget`, a projection reports whether the addition
// lands over, and the process exits 1 when the measured total is over.
//
// Reads only. Writes nothing. Makes no network calls.
//
// Usage:
//   node context-footprint.mjs --root <dir>
//   node context-footprint.mjs --root <dir> --json
//   node context-footprint.mjs --root <dir> --budget <bytes>
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
 * Does this text carry YAML frontmatter with a top-level `paths:` key?
 *
 * Frontmatter on rules is a flat, hand-written key block, so a deliberately
 * naive scan — opening `---` line, closing `---` line, any top-level `paths:`
 * key between them — is enough. A YAML library would buy fidelity the one
 * decision this feeds (conditional vs always-loaded) never needs.
 */
function frontmatterHasPaths(text) {
  const lines = /^---\r?\n/.test(text) ? text.split(/\r?\n/) : null;
  if (!lines) return false;
  const close = lines.findIndex((line, i) => i > 0 && (line === '---' || line === '...'));
  if (close === -1) return false; // no closing delimiter: not frontmatter
  return lines.slice(1, close).some((line) => /^paths:/.test(line));
}

function ruleIsConditional(absRule) {
  try {
    return frontmatterHasPaths(readFileSync(absRule, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The always-loaded budget from <root>/workspace.json, or null when the file or
 * the `workspace.alwaysLoadedBudgetBytes` field is absent. A present but
 * malformed workspace.json throws — silently ignoring a corrupt config would
 * report "no budget" for a workspace that tried to set one.
 */
function readBudget(absRoot) {
  const configPath = join(absRoot, 'workspace.json');
  if (!existsSync(configPath)) return null;
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const budget = raw?.workspace?.alwaysLoadedBudgetBytes;
  return typeof budget === 'number' && Number.isFinite(budget) && budget >= 0 ? budget : null;
}

/**
 * Measure the always-loaded set under `root`.
 *
 * Three groups, kept separate because they cost different things:
 * - `files` / `totalBytes` — CLAUDE.md, its @-imports, and unconditional
 *   rules: what every session pays, and the number the budget judges.
 * - `conditional` — rules with `paths:` frontmatter, reported with kind
 *   `rule-scoped` but excluded from the total: they load only when Claude
 *   touches a file matching one of their globs.
 * - `local` — CLAUDE.local.md and its imports: per-user and gitignored, so
 *   folding them into the shared total would overstate what the team pays.
 */
function measure({ root = '.' } = {}) {
  const absRoot = resolve(root);
  const always = [];
  const conditional = [];
  const missingImports = [];

  const claudeMd = join(absRoot, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const visited = new Set([claudeMd]);
    always.push({ abs: claudeMd, kind: 'claude-md' });
    for (const imp of resolveImports(claudeMd, visited, missingImports)) {
      always.push({ abs: imp, kind: 'import' });
    }
  }

  for (const r of collectRules(absRoot)) {
    if (ruleIsConditional(r)) conditional.push({ abs: r, kind: 'rule-scoped' });
    else always.push({ abs: r, kind: 'rule' });
  }

  const toEntries = (group) => group
    .map((f) => {
      const bytes = sizeOf(f.abs);
      return bytes === null ? null : { path: toPosix(relative(absRoot, f.abs)), bytes, kind: f.kind };
    })
    .filter((e) => e !== null)
    .sort((a, b) => b.bytes - a.bytes);

  const entries = toEntries(always);
  const conditionalEntries = toEntries(conditional);

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

  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const totalTokens = Math.round(totalBytes / BYTES_PER_TOKEN);
  return {
    root: absRoot,
    totalBytes,
    totalTokens,
    percentOfWindow: Number(((totalTokens / CONTEXT_WINDOW) * 100).toFixed(1)),
    files: entries,
    conditional: {
      totalBytes: conditionalEntries.reduce((sum, e) => sum + e.bytes, 0),
      files: conditionalEntries,
    },
    missingImports,
    local: { totalBytes: localBytes, files: localEntries },
  };
}

function projectCost(measurement, addedBytes, destination, budgetBytes = null) {
  const dest = DESTINATIONS[destination];
  if (!dest) throw new Error(`unknown destination: ${destination}`);
  const delta = dest.alwaysLoadedCost(addedBytes);
  const newTotalBytes = measurement.totalBytes + delta;
  const newTokens = Math.round(newTotalBytes / BYTES_PER_TOKEN);
  const projection = {
    destination,
    addedBytes,
    alwaysLoadedDelta: delta,
    newTotalBytes,
    newPercentOfWindow: Number(((newTokens / CONTEXT_WINDOW) * 100).toFixed(1)),
    note: dest.note,
  };
  if (budgetBytes !== null) {
    projection.budgetBytes = budgetBytes;
    projection.overBudgetAfter = newTotalBytes > budgetBytes;
  }
  return projection;
}

function parseArgs(argv) {
  const args = { root: '.', json: false, add: null, as: null, budget: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--root') { args.root = rest[++i]; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--add') { args.add = Number(rest[++i]); continue; }
    if (a === '--as') { args.as = rest[++i]; continue; }
    if (a === '--budget') { args.budget = Number(rest[++i]); continue; }
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
  if (args.budget !== null && (!Number.isFinite(args.budget) || args.budget < 0)) {
    throw new Error('--budget expects a non-negative number of bytes');
  }
  return args;
}

function renderHuman(m, budget, projection) {
  const row = (bytes, label, rest) =>
    `${String(bytes).padStart(7)}  ${label.padEnd(12)}  ${rest}`;
  const lines = [];
  for (const f of m.files) {
    lines.push(row(f.bytes, f.kind, f.path));
  }
  lines.push('-'.repeat(60));
  lines.push(
    row(m.totalBytes, 'TOTAL',
      `~${m.totalTokens} tokens, ${m.percentOfWindow}% of a ${CONTEXT_WINDOW / 1000}k window`),
  );
  if (m.local.totalBytes > 0) {
    lines.push(row(m.local.totalBytes, 'local', '(per-user, not counted above)'));
  }
  if (m.conditional.totalBytes > 0) {
    lines.push('');
    lines.push('conditional (loads only on matching paths, not counted above):');
    for (const f of m.conditional.files) {
      lines.push(row(f.bytes, f.kind, f.path));
    }
    lines.push(row(m.conditional.totalBytes, 'scoped', '(conditional rules, not counted above)'));
  }
  if (m.missingImports.length > 0) {
    lines.push(`         dangling @-imports: ${m.missingImports.join(', ')}`);
  }
  if (budget) {
    lines.push('');
    lines.push(`BUDGET  ${m.totalBytes}/${budget.bytes} bytes — ${budget.overBudget ? 'OVER' : 'ok'}`);
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
    if (projection.overBudgetAfter !== undefined) {
      lines.push(
        projection.overBudgetAfter
          ? `over budget: ${projection.newTotalBytes} > ${projection.budgetBytes} B`
          : `within budget: ${projection.newTotalBytes} / ${projection.budgetBytes} B`,
      );
    }
    lines.push(projection.note);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const m = measure({ root: args.root });
  const budgetBytes = args.budget !== null ? args.budget : readBudget(m.root);
  const budget = budgetBytes === null
    ? null
    : { bytes: budgetBytes, overBudget: m.totalBytes > budgetBytes };
  const projection = args.add !== null ? projectCost(m, args.add, args.as, budgetBytes) : null;
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        { ...m, budget: budgetBytes, overBudget: budget ? budget.overBudget : false, projection },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(renderHuman(m, budget, projection) + '\n');
  }
  if (budget?.overBudget) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`context-footprint: ${err.message}\n`);
    process.exit(2);
  }
}

export {
  measure, projectCost, parseArgs, resolveImports, readBudget, frontmatterHasPaths,
  DESTINATIONS, BYTES_PER_TOKEN, CONTEXT_WINDOW,
};
