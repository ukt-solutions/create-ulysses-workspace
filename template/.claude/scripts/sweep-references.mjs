#!/usr/bin/env node
// Sed-style scripted find-replace across a target tree.
//
// Mechanizes the long-tail string updates in rule prose, skill instructions,
// hooks, and code so we don't burn LLM tokens (and chances for typo) doing
// it by hand. Used by:
//   - the v0.15 template PR (run on template/)
//   - the migrator (run on the dogfood workspace itself)
//
// Replacement rules are ordered longest-pattern-first so we don't get
// cascading double-replacements (e.g. shared-context/locked → workspace-context/shared/locked
// must run before shared-context/ → workspace-context/).
//
// Usage:
//   node sweep-references.mjs --check  --target <dir>
//   node sweep-references.mjs --write  --target <dir>
//
// Skips:
//   - any path containing /release-notes/archive/
//   - any path containing /scaffolder-release-history/
//   - .git/, node_modules/
//   - the script's own file (avoids self-rewrite)
//   - binary files (detected via null-byte heuristic)

import { readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const DEFAULT_RULES = [
  // Order matters — longest patterns first.
  { from: 'shared-context/locked', to: 'workspace-context/shared/locked' },
  { from: 'shared-context/', to: 'workspace-context/' },
  { from: 'shared-context', to: 'workspace-context' },
  { from: 'sharedContextDir', to: 'workspaceContextDir' },
];

const SKIP_PATH_FRAGMENTS = [
  `${sep}release-notes${sep}archive${sep}`,
  `${sep}scaffolder-release-history${sep}`,
  `${sep}.git${sep}`,
  `${sep}node_modules${sep}`,
];

// Scripts whose contents intentionally contain the literal "before" strings as
// part of their behavior (the migrator's constants, test fixtures verifying
// rule firing). Skipping by basename keeps the sweeper from mangling them.
const SKIP_BASENAMES = new Set([
  'migrate-to-workspace-context.mjs',
  'migrate-to-workspace-context.test.mjs',
  'sweep-references.test.mjs',
]);

function parseArgs(argv) {
  const args = { mode: null, target: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.mode = 'check';
    else if (a === '--write') args.mode = 'write';
    else if (a === '--target') args.target = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.mode) throw new Error('Specify --check or --write');
  if (!args.target) throw new Error('--target <dir> is required');
  return args;
}

function shouldSkip(absPath, scriptPath) {
  if (absPath === scriptPath) return true;
  for (const frag of SKIP_PATH_FRAGMENTS) {
    if (absPath.includes(frag)) return true;
  }
  const base = absPath.split(sep).pop();
  if (SKIP_BASENAMES.has(base)) return true;
  return false;
}

function* walk(dir) {
  const entries = readdirSync(dir);
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

function isLikelyBinary(buffer) {
  // Quick null-byte heuristic, sampling the first 4 KiB
  const sample = buffer.slice(0, Math.min(4096, buffer.length));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

function applyRules(content, rules = DEFAULT_RULES) {
  let out = content;
  let total = 0;
  const perRule = [];
  for (const rule of rules) {
    let count = 0;
    let idx = out.indexOf(rule.from);
    while (idx !== -1) {
      count++;
      idx = out.indexOf(rule.from, idx + rule.from.length);
    }
    if (count > 0) {
      out = out.split(rule.from).join(rule.to);
      total += count;
      perRule.push({ from: rule.from, to: rule.to, count });
    }
  }
  return { content: out, total, perRule };
}

function sweep(targetDir, { rules = DEFAULT_RULES, write = false, scriptPath = '' } = {}) {
  const absTarget = resolve(targetDir);
  const changes = [];
  for (const path of walk(absTarget)) {
    if (shouldSkip(path, scriptPath)) continue;
    let buf;
    try { buf = readFileSync(path); } catch { continue; }
    if (isLikelyBinary(buf)) continue;
    const text = buf.toString('utf-8');
    const result = applyRules(text, rules);
    if (result.total === 0) continue;
    changes.push({
      path: relative(absTarget, path),
      total: result.total,
      perRule: result.perRule,
    });
    if (write) writeFileSync(path, result.content);
  }
  return changes;
}

function main() {
  const args = parseArgs(process.argv);
  const scriptPath = process.argv[1];
  const changes = sweep(args.target, {
    rules: DEFAULT_RULES,
    write: args.mode === 'write',
    scriptPath,
  });
  process.stdout.write(
    JSON.stringify({
      mode: args.mode,
      target: args.target,
      filesChanged: changes.length,
      totalReplacements: changes.reduce((acc, c) => acc + c.total, 0),
      changes,
    }, null, 2) + '\n',
  );
  if (args.mode === 'check' && changes.length > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`sweep-references: ${err.message}\n`);
    process.exit(2);
  }
}

export { applyRules, sweep, DEFAULT_RULES };
