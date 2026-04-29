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
// Canonical files honor a configurable byte budget. Each locked file declares
// `priority: critical | reference` in its frontmatter (default: critical).
// Section-level `<!-- canonical:trim --> ... <!-- canonical:end-trim -->` markers
// fence droppable spans inside reference files. When canonical body bytes exceed
// the budget, the builder trims reference files first, then stubs them, in that
// deterministic order. Critical files are never modified.
//
// Usage:
//   node build-workspace-context.mjs --write [--root <workspace-root>]
//   node build-workspace-context.mjs --check [--root <workspace-root>]
//
// --write regenerates all three artifacts.
// --check exit codes:
//   0 — all artifacts current and canonical within budget
//   1 — at least one artifact missing or stale (regenerate via --write)
//   2 — artifacts current, but canonical body exceeds budget after trimming and stubbing
// Stale wins over over-budget when both apply.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSessionContent } from '../lib/session-frontmatter.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

export const DEFAULT_CANONICAL_BUDGET = 40960;

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

const TRIM_OPEN_RE = /<!--\s*canonical:trim\s*-->/g;
const TRIM_CLOSE_RE = /<!--\s*canonical:end-trim\s*-->/g;
const TRIM_BLOCK_RE = /<!--\s*canonical:trim\s*-->[\s\S]*?<!--\s*canonical:end-trim\s*-->\n?/g;
const ANY_MARKER_RE = /<!--\s*canonical:(?:end-)?trim\s*-->\n?/g;

/**
 * Validate that canonical:trim markers are well-formed in `body`. Throws an
 * Error if an opener has no matching closer, or if a second opener appears
 * before the corresponding end-trim. Used by extractCanonicalVariants.
 */
function validateTrimMarkers(body, name) {
  let depth = 0;
  let idx = 0;
  while (idx < body.length) {
    TRIM_OPEN_RE.lastIndex = idx;
    TRIM_CLOSE_RE.lastIndex = idx;
    const openMatch = TRIM_OPEN_RE.exec(body);
    const closeMatch = TRIM_CLOSE_RE.exec(body);
    const openAt = openMatch ? openMatch.index : -1;
    const closeAt = closeMatch ? closeMatch.index : -1;
    if (openAt === -1 && closeAt === -1) break;
    if (openAt !== -1 && (closeAt === -1 || openAt < closeAt)) {
      if (depth > 0) {
        throw new Error(`canonical:trim parse error in ${name}: nested opener at offset ${openAt}`);
      }
      depth = 1;
      idx = openAt + openMatch[0].length;
    } else {
      if (depth === 0) {
        throw new Error(`canonical:trim parse error in ${name}: unmatched end-trim at offset ${closeAt}`);
      }
      depth = 0;
      idx = closeAt + closeMatch[0].length;
    }
  }
  if (depth !== 0) {
    throw new Error(`canonical:trim parse error in ${name}: unmatched opener (no end-trim before EOF)`);
  }
}

/**
 * Collapse runs of three or more consecutive newlines to two so that variant
 * outputs do not grow extra blank lines after marker removal.
 */
function collapseBlankLines(s) {
  return s.replace(/\n{3,}/g, '\n\n');
}

/**
 * Compute the three body variants for a single locked file.
 *
 * Inputs: { name, rawContent } where rawContent is the file as read from disk
 * (frontmatter still present). Output: { full, trimmed, stub } — each is the
 * body string used for canonical rendering when that variant is selected.
 *
 * - `full` — frontmatter stripped, all `canonical:trim`/`canonical:end-trim`
 *   marker lines removed but their content kept.
 * - `trimmed` — fenced spans (markers + content) replaced with a one-line
 *   breadcrumb. Consecutive breadcrumbs collapse to one. Bare markers are
 *   stripped defensively.
 * - `stub` — the entire body is replaced with a one-line breadcrumb pointing
 *   to the source file.
 *
 * Throws if markers are malformed (unmatched opener or nested opener).
 */
export function extractCanonicalVariants({ name, rawContent }) {
  const body = stripFrontmatter(rawContent);
  validateTrimMarkers(body, name);

  // full: drop all marker lines but keep content.
  const full = collapseBlankLines(body.replace(ANY_MARKER_RE, '')).trimEnd();

  // trimmed: replace fenced spans with breadcrumb, collapse consecutive
  // breadcrumbs, then strip any remaining bare markers (defensive).
  const breadcrumb = `> _Trimmed for canonical budget — see \`shared/locked/${name}.md\` for full content._\n`;
  let trimmed = body.replace(TRIM_BLOCK_RE, breadcrumb);
  // Collapse consecutive identical breadcrumb lines into one.
  const breadcrumbLine = breadcrumb.trimEnd();
  const escapedBreadcrumb = breadcrumbLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const consecutiveBreadcrumbs = new RegExp(`(?:${escapedBreadcrumb}\\n)+`, 'g');
  trimmed = trimmed.replace(consecutiveBreadcrumbs, breadcrumb);
  trimmed = trimmed.replace(ANY_MARKER_RE, '');
  trimmed = collapseBlankLines(trimmed).trimEnd();

  const stub = `> _Dropped for canonical budget — see \`shared/locked/${name}.md\`._`;

  return { full, trimmed, stub };
}

/**
 * Read `workspace.canonicalBudgetBytes` from `workspace.json`.
 * Returns:
 *   - The integer value when set to a non-negative integer.
 *   - 0 when set to 0 or a negative number (treated as disabled).
 *   - DEFAULT_CANONICAL_BUDGET when the field is absent or workspace.json is missing.
 *   - DEFAULT_CANONICAL_BUDGET (with a stderr warning) when workspace.json fails to parse.
 */
export function readWorkspaceBudget(workspaceRoot) {
  const path = join(workspaceRoot, 'workspace.json');
  if (!existsSync(path)) return DEFAULT_CANONICAL_BUDGET;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    process.stderr.write(`warning: failed to parse workspace.json (${err.message}); using default canonical budget\n`);
    return DEFAULT_CANONICAL_BUDGET;
  }
  const ws = parsed && typeof parsed === 'object' ? parsed.workspace : null;
  if (!ws || typeof ws !== 'object') return DEFAULT_CANONICAL_BUDGET;
  if (!('canonicalBudgetBytes' in ws)) return DEFAULT_CANONICAL_BUDGET;
  const v = ws.canonicalBudgetBytes;
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_CANONICAL_BUDGET;
  if (v <= 0) return 0;
  return Math.floor(v);
}

/**
 * Render just the per-item body of canonical (no frontmatter, no header).
 * Pure function used both by selectCanonicalContent (to measure body bytes)
 * and by renderCanonical (to emit the final document).
 */
export function renderCanonicalBody(resolvedItems) {
  if (resolvedItems.length === 0) return '';
  const parts = [];
  for (const item of resolvedItems) {
    parts.push(`## ${item.name}\n\n${item.content}\n`);
  }
  return parts.join('\n');
}

/**
 * Pick a canonical resolution that fits the budget when possible.
 *
 * Items shape: { name, priority, full, trimmed, stub }.
 * Returns { resolvedItems, selection } where selection has:
 *   - status: 'ok' | 'trimmed' | 'stubbed' | 'over-budget'
 *   - budgetBytes: number or null (null when budget is disabled)
 *   - currentBytes: body bytes after the chosen resolution
 *   - overBy?: number (present when status === 'over-budget')
 *   - trimmedFiles, stubbedFiles: names of items resolved that way
 *
 * Algorithm (deterministic, four stages):
 *   1. All items → full. If body ≤ budget: status `ok`.
 *   2. Reference items → trimmed; critical → full. If ≤ budget: `trimmed`.
 *   3. Reference items → stub; critical → full. If ≤ budget: `stubbed`.
 *   4. Keep stage-3 resolution; status `over-budget`, overBy populated.
 *
 * Special cases:
 *   - budgetBytes <= 0: stage 1 always wins, selection.budgetBytes = null.
 *   - No reference items present and stage 1 fails: status `over-budget`,
 *     no transformation possible. Stderr warning is emitted.
 */
export function selectCanonicalContent(items, budgetBytes, opts) {
  const measure = opts && typeof opts.measureBodyBytes === 'function'
    ? opts.measureBodyBytes
    : (resolved) => Buffer.byteLength(renderCanonicalBody(resolved), 'utf-8');

  const resolveAt = (stage) => items.map((item) => {
    if (stage === 1) return { name: item.name, priority: item.priority, content: item.full };
    if (item.priority === 'reference') {
      return {
        name: item.name,
        priority: item.priority,
        content: stage === 2 ? item.trimmed : item.stub,
      };
    }
    return { name: item.name, priority: item.priority, content: item.full };
  });

  // Disabled-budget path.
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    const resolved = resolveAt(1);
    return {
      resolvedItems: resolved,
      selection: {
        status: 'ok',
        budgetBytes: null,
        currentBytes: measure(resolved),
        trimmedFiles: [],
        stubbedFiles: [],
      },
    };
  }

  // Stage 1: full.
  const stage1 = resolveAt(1);
  const stage1Bytes = measure(stage1);
  if (stage1Bytes <= budgetBytes) {
    return {
      resolvedItems: stage1,
      selection: {
        status: 'ok',
        budgetBytes,
        currentBytes: stage1Bytes,
        trimmedFiles: [],
        stubbedFiles: [],
      },
    };
  }

  const referenceNames = items.filter((i) => i.priority === 'reference').map((i) => i.name);

  // No reference files exist → cannot trim. Report over-budget at stage 1.
  if (referenceNames.length === 0) {
    process.stderr.write('warning: no priority:reference files exist — consider demoting one via /maintenance cleanup\n');
    return {
      resolvedItems: stage1,
      selection: {
        status: 'over-budget',
        budgetBytes,
        currentBytes: stage1Bytes,
        overBy: stage1Bytes - budgetBytes,
        trimmedFiles: [],
        stubbedFiles: [],
      },
    };
  }

  // Stage 2: trim reference files.
  const stage2 = resolveAt(2);
  const stage2Bytes = measure(stage2);
  if (stage2Bytes <= budgetBytes) {
    return {
      resolvedItems: stage2,
      selection: {
        status: 'trimmed',
        budgetBytes,
        currentBytes: stage2Bytes,
        trimmedFiles: referenceNames,
        stubbedFiles: [],
      },
    };
  }

  // Stage 3: stub reference files.
  const stage3 = resolveAt(3);
  const stage3Bytes = measure(stage3);
  if (stage3Bytes <= budgetBytes) {
    return {
      resolvedItems: stage3,
      selection: {
        status: 'stubbed',
        budgetBytes,
        currentBytes: stage3Bytes,
        trimmedFiles: [],
        stubbedFiles: referenceNames,
      },
    };
  }

  // Stage 4: still over. Keep stage-3 resolution.
  return {
    resolvedItems: stage3,
    selection: {
      status: 'over-budget',
      budgetBytes,
      currentBytes: stage3Bytes,
      overBy: stage3Bytes - budgetBytes,
      trimmedFiles: [],
      stubbedFiles: referenceNames,
    },
  };
}

function buildCanonical(workspaceRoot) {
  const lockedDir = join(workspaceRoot, WC_DIR, SHARED_DIR, LOCKED_DIR);
  if (!existsSync(lockedDir)) return [];
  const files = walkMarkdown(lockedDir).filter((f) => !f.endsWith('.keep')).sort();
  const items = [];
  for (const f of files) {
    const name = f.split(sep).pop().replace(/\.md$/, '');
    const rawContent = readFileSync(f, 'utf-8');
    let priority = 'critical';
    try {
      const parsed = parseSessionContent(rawContent);
      const fields = parsed.fields || {};
      if (typeof fields.priority === 'string' && fields.priority.trim()) {
        priority = fields.priority.trim();
      }
    } catch {
      // No parseable frontmatter — keep default 'critical'.
    }
    const variants = extractCanonicalVariants({ name, rawContent });
    if (priority === 'reference' && variants.trimmed === variants.full) {
      process.stderr.write(`warning: reference file '${name}' has no canonical:trim markers; trimming is a no-op for it\n`);
    }
    items.push({ name, priority, full: variants.full, trimmed: variants.trimmed, stub: variants.stub });
  }
  return items;
}

function summarizeSelection(selection) {
  if (selection.status === 'ok') return 'full';
  if (selection.status === 'trimmed') return `${selection.trimmedFiles.length} reference files trimmed`;
  if (selection.status === 'stubbed') return `${selection.stubbedFiles.length} reference files stubbed`;
  return `over budget by ${selection.overBy} bytes`;
}

function renderCanonical(resolvedItems, selection, generatedAt) {
  const showBudget = selection && selection.budgetBytes !== null && selection.budgetBytes !== undefined;
  const fmLines = ['---', 'type: canonical', `generated: ${generatedAt}`];
  if (showBudget) {
    fmLines.push(`budget: ${selection.budgetBytes}`);
    fmLines.push(`status: ${selection.status}`);
  }
  fmLines.push('---', '');

  const lines = [
    ...fmLines,
    '# workspace-context — canonical truths',
    '',
    '> Auto-generated concatenation of `shared/locked/*.md`. Hand edits will be overwritten — update source files instead.',
  ];
  if (showBudget) {
    lines.push(
      `> Budget: ${selection.budgetBytes} bytes (body); current: ${selection.currentBytes} bytes; status: ${selection.status} (${summarizeSelection(selection)}).`,
    );
  }
  lines.push('');

  if (resolvedItems.length === 0) {
    lines.push('_(no canonical entries yet — promote one via `/release`)_', '');
    return lines.join('\n');
  }

  const body = renderCanonicalBody(resolvedItems);
  // body already ends with \n (each item ends in \n, joined by \n). Append directly.
  return lines.join('\n') + body;
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
  const budget = readWorkspaceBudget(workspaceRoot);
  const { resolvedItems, selection } = selectCanonicalContent(canonicalItems, budget, {
    measureBodyBytes: (resolved) => Buffer.byteLength(renderCanonicalBody(resolved), 'utf-8'),
  });
  out.push({
    path: join(wcRoot, CANONICAL_FILENAME),
    label: 'canonical.md',
    content: renderCanonical(resolvedItems, selection, generatedAt) + '\n',
    selection,
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

/**
 * CLI entry point.
 *
 * Exit codes for `--check`:
 *   0 — all artifacts current and canonical body is within budget.
 *   1 — at least one artifact is missing or stale on disk. Run `--write`.
 *   2 — artifacts are current but canonical body exceeds budget after
 *       trimming and stubbing eligible reference files. Triage via
 *       `/maintenance cleanup`. If both stale and over-budget, exit 1.
 *
 * `--write` always exits 0 on successful regeneration; over-budget is
 * surfaced as a stderr warning during selection but does not block the write.
 */
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

    const canonicalArtifact = artifacts.find((a) => a.label === 'canonical.md');
    const sel = canonicalArtifact ? canonicalArtifact.selection : null;
    const canonicalBlock = sel ? {
      budget: sel.budgetBytes,
      current: sel.currentBytes,
      ...(sel.overBy !== undefined ? { overBy: sel.overBy } : {}),
      selectionStatus: sel.status,
      trimmedFiles: sel.trimmedFiles,
      stubbedFiles: sel.stubbedFiles,
    } : null;

    if (missing.length === 0 && stale.length === 0) {
      const overBudget = sel && sel.status === 'over-budget';
      const payload = { status: 'current', missing: [], stale: [] };
      if (canonicalBlock) payload.canonical = canonicalBlock;
      payload.artifacts = artifacts.length;
      process.stdout.write(JSON.stringify(payload) + '\n');
      process.exit(overBudget ? 2 : 0);
    }

    const payload = { status: 'stale', missing, stale };
    if (canonicalBlock) payload.canonical = canonicalBlock;
    process.stdout.write(JSON.stringify(payload) + '\n');
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

if (isMainModule(import.meta.url)) main();

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
