#!/usr/bin/env node
// Generate workspace-context auto-files from filesystem state.
//
// One pass, three artifacts:
//   workspace-context/index.md            — navigation surface (shared/ + shared/locked/)
//   workspace-context/canonical.md        — full-content concat of shared/locked/*.md
//   workspace-context/team-member/{user}/index.md — per-user navigation
//
// Source of truth: the filesystem. Hand edits are overwritten on regeneration.
// Gitignored files are excluded automatically. .indexignore adds prefix excludes.
//
// Usage:
//   node build-workspace-context.mjs --write [--root <workspace-root>]
//   node build-workspace-context.mjs --check [--root <workspace-root>]
//
// --write regenerates all three artifacts.
// --check exits 0 if everything matches, 1 if any is stale or missing. Reports per-file status.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSessionContent } from '../lib/session-frontmatter.mjs';

const WC_DIR = 'workspace-context';
const SHARED_DIR = 'shared';
const LOCKED_DIR = 'locked';
const TEAM_MEMBER_DIR = 'team-member';
const INDEX_FILENAME = 'index.md';
const CANONICAL_FILENAME = 'canonical.md';
const IGNORE_FILENAME = '.indexignore';

function parseArgs(argv) {
  const args = { mode: null, root: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') args.mode = 'write';
    else if (a === '--check') args.mode = 'check';
    else if (a === '--root') args.root = argv[++i];
  }
  if (!args.mode) throw new Error('Specify --write or --check');
  return args;
}

function walkMarkdown(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkMarkdown(full));
    else if (st.isFile() && name.endsWith('.md')) out.push(full);
  }
  return out;
}

function readDescription(filePath) {
  let frontmatter = {};
  let body = '';
  try {
    const parsed = parseSessionContent(readFileSync(filePath, 'utf-8'));
    frontmatter = parsed.fields || {};
    body = parsed.body || '';
  } catch {
    body = readFileSync(filePath, 'utf-8');
  }

  if (typeof frontmatter.description === 'string' && frontmatter.description.trim()) {
    return frontmatter.description.trim();
  }
  const stripped = body.replace(/^#.*$/m, '').trim();
  const firstParagraph = stripped.split(/\n\s*\n/, 1)[0] || '';
  const firstSentence = firstParagraph.replace(/\n/g, ' ').match(/[^.!?]+[.!?]/);
  if (firstSentence) {
    const candidate = firstSentence[0].trim();
    if (candidate.length > 0 && candidate.length <= 200) return candidate;
  }
  const filename = filePath.split(sep).pop() || '';
  return filename.replace(/\.md$/, '').replace(/^(braindump|handoff|research)_/, '').replace(/-/g, ' ');
}

function readIgnorePrefixes(wcDir) {
  const ignorePath = join(wcDir, IGNORE_FILENAME);
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l.length > 0);
}

function isIgnored(relativePath, prefixes) {
  for (const prefix of prefixes) {
    if (relativePath === prefix) return true;
    if (relativePath.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) return true;
  }
  return false;
}

function gitIgnoredPaths(workspaceRoot, paths) {
  if (paths.length === 0) return new Set();
  const result = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: workspaceRoot,
    input: paths.join('\n'),
    encoding: 'utf-8',
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) return new Set();
  return new Set(
    result.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0),
  );
}

function stripFrontmatter(content) {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return content;
  return content.slice(end + 5).replace(/^\n+/, '');
}

function describeAndPath(filePath, wcRoot) {
  const rel = relative(wcRoot, filePath).split(sep).join('/');
  return { rel, description: readDescription(filePath) };
}

// ---------- shared index ----------

function buildSharedIndex(workspaceRoot) {
  const wcRoot = join(workspaceRoot, WC_DIR);
  const sharedDir = join(wcRoot, SHARED_DIR);
  if (!existsSync(sharedDir)) return [];

  const ignorePrefixes = readIgnorePrefixes(wcRoot);
  const candidates = walkMarkdown(sharedDir);
  const candidatePaths = candidates.map((f) => relative(workspaceRoot, f).split(sep).join('/'));
  const gitIgnored = gitIgnoredPaths(workspaceRoot, candidatePaths);

  const entries = [];
  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i];
    const relToWC = relative(wcRoot, f).split(sep).join('/');
    if (relToWC === INDEX_FILENAME || relToWC === CANONICAL_FILENAME) continue;
    if (isIgnored(relToWC, ignorePrefixes)) continue;
    if (gitIgnored.has(candidatePaths[i])) continue;
    const isLocked = relToWC.startsWith(`${SHARED_DIR}/${LOCKED_DIR}/`);
    const { description } = describeAndPath(f, wcRoot);
    entries.push({ rel: relToWC, isLocked, description });
  }
  entries.sort((a, b) => {
    if (a.isLocked !== b.isLocked) return a.isLocked ? -1 : 1;
    return a.rel.localeCompare(b.rel);
  });
  return entries;
}

function renderSharedIndex(entries, generatedAt) {
  const lines = [
    '---',
    'type: index',
    `generated: ${generatedAt}`,
    '---',
    '',
    '# workspace-context — index',
    '',
    '> Auto-generated by `.claude/scripts/build-workspace-context.mjs`. Hand edits will be overwritten — update source files instead.',
    '',
  ];
  const locked = entries.filter((e) => e.isLocked);
  const other = entries.filter((e) => !e.isLocked);
  if (locked.length > 0) {
    lines.push('## Canonical (in CLAUDE.md context verbatim)', '');
    for (const e of locked) lines.push(`- [${e.rel}](${e.rel}) — ${e.description}`);
    lines.push('');
  }
  if (other.length > 0) {
    lines.push('## Shared', '');
    for (const e of other) lines.push(`- [${e.rel}](${e.rel}) — ${e.description}`);
    lines.push('');
  }
  if (entries.length === 0) {
    lines.push('_(no shared workspace-context files yet)_', '');
  }
  return lines.join('\n');
}

// ---------- canonical concat ----------

function buildCanonical(workspaceRoot) {
  const lockedDir = join(workspaceRoot, WC_DIR, SHARED_DIR, LOCKED_DIR);
  if (!existsSync(lockedDir)) return [];
  return walkMarkdown(lockedDir)
    .filter((f) => !f.endsWith('.keep'))
    .sort()
    .map((f) => ({
      name: f.split(sep).pop().replace(/\.md$/, ''),
      content: stripFrontmatter(readFileSync(f, 'utf-8')).trimEnd(),
    }));
}

function renderCanonical(items, generatedAt) {
  const lines = [
    '---',
    'type: canonical',
    `generated: ${generatedAt}`,
    '---',
    '',
    '# workspace-context — canonical truths',
    '',
    '> Auto-generated concatenation of `shared/locked/*.md`. Hand edits will be overwritten — update source files instead.',
    '',
  ];
  for (const item of items) {
    lines.push(`## ${item.name}`, '', item.content, '');
  }
  if (items.length === 0) {
    lines.push('_(no canonical entries yet — promote one via `/release`)_', '');
  }
  return lines.join('\n');
}

// ---------- team-member indexes ----------

function buildTeamMemberIndex(workspaceRoot, user) {
  const userDir = join(workspaceRoot, WC_DIR, TEAM_MEMBER_DIR, user);
  if (!existsSync(userDir)) return [];

  const candidates = walkMarkdown(userDir).filter(
    (f) => f.split(sep).pop() !== INDEX_FILENAME,
  );
  const candidatePaths = candidates.map((f) => relative(workspaceRoot, f).split(sep).join('/'));
  const gitIgnored = gitIgnoredPaths(workspaceRoot, candidatePaths);

  const entries = [];
  for (let i = 0; i < candidates.length; i++) {
    if (gitIgnored.has(candidatePaths[i])) continue;
    const relToUserDir = relative(userDir, candidates[i]).split(sep).join('/');
    const description = readDescription(candidates[i]);
    entries.push({ rel: relToUserDir, description });
  }
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return entries;
}

function renderTeamMemberIndex(user, entries, generatedAt) {
  const lines = [
    '---',
    'type: index',
    `generated: ${generatedAt}`,
    '---',
    '',
    `# ${user}'s context`,
    '',
    '> Auto-generated by `.claude/scripts/build-workspace-context.mjs`. Hand edits will be overwritten.',
    '',
  ];
  for (const e of entries) {
    lines.push(`- [${e.rel}](${e.rel}) — ${e.description}`);
  }
  if (entries.length === 0) {
    lines.push('_(no personal context files yet)_');
  }
  return lines.join('\n') + '\n';
}

function listTeamMembers(workspaceRoot) {
  const tmDir = join(workspaceRoot, WC_DIR, TEAM_MEMBER_DIR);
  if (!existsSync(tmDir)) return [];
  return readdirSync(tmDir)
    .filter((name) => {
      const full = join(tmDir, name);
      return statSync(full).isDirectory();
    })
    .sort();
}

// ---------- orchestration ----------

function fingerprint(content) {
  return content
    .split('\n')
    .filter((l) => !l.startsWith('generated:'))
    .join('\n');
}

function regenerateAll(workspaceRoot, generatedAt) {
  const wcRoot = join(workspaceRoot, WC_DIR);
  if (!existsSync(wcRoot)) return [];

  const out = [];
  const sharedEntries = buildSharedIndex(workspaceRoot);
  out.push({
    path: join(wcRoot, INDEX_FILENAME),
    label: 'index.md',
    content: renderSharedIndex(sharedEntries, generatedAt) + '\n',
  });

  const canonicalItems = buildCanonical(workspaceRoot);
  out.push({
    path: join(wcRoot, CANONICAL_FILENAME),
    label: 'canonical.md',
    content: renderCanonical(canonicalItems, generatedAt) + '\n',
  });

  for (const user of listTeamMembers(workspaceRoot)) {
    const entries = buildTeamMemberIndex(workspaceRoot, user);
    out.push({
      path: join(wcRoot, TEAM_MEMBER_DIR, user, INDEX_FILENAME),
      label: `team-member/${user}/index.md`,
      content: renderTeamMemberIndex(user, entries, generatedAt),
    });
  }

  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const generatedAt = new Date().toISOString();
  const artifacts = regenerateAll(args.root, generatedAt);

  if (args.mode === 'check') {
    const stale = [];
    const missing = [];
    for (const a of artifacts) {
      if (!existsSync(a.path)) { missing.push(a.label); continue; }
      const onDisk = readFileSync(a.path, 'utf-8');
      if (fingerprint(onDisk) !== fingerprint(a.content)) stale.push(a.label);
    }
    if (missing.length === 0 && stale.length === 0) {
      process.stdout.write(JSON.stringify({ status: 'current', artifacts: artifacts.length }) + '\n');
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ status: 'stale', missing, stale }) + '\n');
    process.exit(1);
  }

  if (args.mode === 'write') {
    for (const a of artifacts) writeFileSync(a.path, a.content);
    process.stdout.write(
      JSON.stringify({ status: 'written', artifacts: artifacts.map((a) => a.label) }) + '\n',
    );
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export {
  buildSharedIndex,
  renderSharedIndex,
  buildCanonical,
  renderCanonical,
  buildTeamMemberIndex,
  renderTeamMemberIndex,
  listTeamMembers,
  regenerateAll,
  fingerprint,
  readDescription,
  stripFrontmatter,
};
