#!/usr/bin/env node
// Classify an upgrade payload's files against the workspace so /workspace-update
// can batch the safe cases and ask only where a decision is needed.
//
// Usage:
//   node classify-update.mjs [--root <dir>] [--payload <dir>]
//   node classify-update.mjs --root <dir> --payload <dir> --write-baseline
//   node classify-update.mjs --root <dir> --payload <dir> --merge-claude-md
//
// --root    workspace root; defaults to the current working directory (never
//           derived from this script's location — the upgrade payload runs
//           this file from <workspace>/.workspace-update/.claude/scripts/)
// --payload the staged payload; defaults to <root>/.workspace-update
//
// The default mode prints JSON with these lists:
//   new        — no installed counterpart and no baseline entry; safe to
//                batch-apply after one confirm
//   identical  — installed file already equals the payload
//   updated    — installed file equals the BASELINE (what the template last
//                shipped here) but not the payload: a pure template change the
//                user never touched. Batched with `new` behind one confirm.
//   differs    — installed file matches neither the payload nor the baseline
//                while the payload also differs from the baseline: a local
//                edit AND a template change — the one case that needs a
//                per-file decision (or the workspace predates baselines and
//                has no entry to compare).
//   localOnly  — installed file differs from the payload, but the payload
//                equals the baseline: the template hasn't touched the file
//                since the last update, so the difference is purely local.
//                Listed for information only — never asked about, never
//                applied.
//   deletedLocally — the baseline records the file and the payload still
//                ships it, but it is missing from the workspace: deleted
//                locally (or never installed at /workspace-init). The skill
//                asks once whether to restore the list.
//   activated  — the payload ships rules/{name}.md.skip while the workspace
//                deliberately keeps {name}.md active; nothing to install, the
//                active rule stays (gh:180)
//   removed    — installed file with no payload counterpart: the template
//                stopped shipping it. Excludes what the workspace owns:
//                *.test.mjs (see staleTests), anything gitignored
//                (machine-local), paths under .claude/worktrees/, and entries
//                of workspace.json → workspace.localFiles (array of
//                .claude/-relative paths or globs for files this workspace
//                owns) (gh:180)
//   staleTests — *.test.mjs files under .claude/ with no payload counterpart.
//                The npm tarball ships no tests, so these came from a dev
//                checkout and are never updated by /workspace-update; the
//                skill offers to remove them (tests live in the template repo)
//
// Plus `hasBaseline`: whether .claude/.template-baseline.json exists. Without
// it (workspaces older than the baseline's introduction) template changes
// cannot be told from local edits, so they land in `differs` — the first
// update after v0.21 asks per file; once it writes the baseline, later updates
// won't.
//
// Content comparisons hash with CRLF normalized to LF on both sides (binary
// files hash byte-exact), so a git autocrlf checkout that stores CRLF where
// the payload ships LF classifies as identical rather than locally modified.
//
// Only verbatim-installed files are classified: everything under .claude/,
// plus .mcp.json and .claudeignore. The payload's templates (*.tmpl, which
// install with {{project-name}} substitution), _gitignore (merged line-by-line
// into the workspace's .gitignore), and .manifest.json (payload metadata) are
// handled by their own steps in /workspace-update and are excluded here.
//
// The other two modes are /workspace-update bookends:
//   --write-baseline  write .claude/.template-baseline.json recording the
//                     hash of every verbatim payload file — what the template
//                     now ships. Run at the END of an update, after all
//                     per-file decisions. Entries record the PAYLOAD hash —
//                     except unapplied updates (workspace still holds the old
//                     baseline content), which keep the old entry so they
//                     present as `updated` again next time; see
//                     template-baseline.mjs. Throws rather than writing an
//                     empty baseline.
//   --merge-claude-md print CLAUDE.md with the payload's CLAUDE.md.tmpl
//                     merged in: template lines updated, the workspace's own
//                     lines (custom skill entries, sections) kept. The skill
//                     shows the diff against the current file before writing.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitIgnoredPaths } from './build-workspace-context.mjs';
import { BASELINE_PATH, hashBytes, readBaseline, writeBaseline } from './template-baseline.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), payload: null, writeBaseline: false, mergeClaudeMd: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--payload') args.payload = argv[++i];
    else if (a === '--write-baseline') args.writeBaseline = true;
    else if (a === '--merge-claude-md') args.mergeClaudeMd = true;
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
  // The template's own .gitignore declares these machine-local; the baseline
  // is per-workspace state the template never ships.
  if (rel === '.claude/settings.local.json' || rel === '.claude/.active-session.json' || rel === BASELINE_PATH) {
    return true;
  }
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
  const baseline = readBaseline(absRoot);

  const result = {
    new: [],
    identical: [],
    updated: [],
    differs: [],
    localOnly: [],
    deletedLocally: [],
    activated: [],
    removed: [],
    staleTests: [],
    hasBaseline: baseline !== null,
  };
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
      // A file the baseline records and the payload still ships, yet missing
      // from the workspace: deleted locally (or declined at install time) —
      // not new, the template has carried it all along.
      if (baseline && typeof baseline.files[rel] === 'string') {
        result.deletedLocally.push(rel);
      } else {
        result.new.push(rel);
      }
      continue;
    }
    const wsHash = hashBytes(readFileSync(installed));
    const payloadHash = hashBytes(readFileSync(join(absPayload, rel)));
    if (wsHash === payloadHash) {
      result.identical.push(rel);
      continue;
    }
    const baseHash = baseline ? baseline.files[rel] : undefined;
    if (baseHash !== undefined && wsHash === baseHash) {
      // Workspace still holds exactly what the template last shipped here —
      // the difference is the template's own change since then.
      result.updated.push(rel);
    } else if (baseHash !== undefined && payloadHash === baseHash) {
      // The payload is unchanged since the baseline; the workspace's
      // difference is purely local. Informational — nothing to apply.
      result.localOnly.push(rel);
    } else {
      // A local edit on top of a template change (or no baseline entry to
      // compare) — the one case that needs a per-file decision.
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
    // Test files never come from the npm tarball; the payload not carrying one
    // means the template's test suite moved on without this copy.
    if (rel.endsWith('.test.mjs')) {
      result.staleTests.push(rel);
      continue;
    }
    if (isOwnedByWorkspace(rel, localFiles)) continue;
    result.removed.push(rel);
  }
  return result;
}

// ---------- CLAUDE.md merge ----------

/**
 * Split markdown into blocks: the preamble (heading null) plus one block per
 * `## ` heading. Deeper headings belong to their enclosing section, and `## `
 * lines inside fenced code blocks (``` or ~~~) stay content of their section.
 */
function splitBlocks(text) {
  const blocks = [];
  let cur = { heading: null, lines: [] };
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^##\s/.test(line)) {
      blocks.push(cur);
      cur = { heading: line.trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  blocks.push(cur);
  return blocks;
}

/**
 * A heading's merge key. Identical headings match; beyond that, any
 * `## Workspace:` heading matches any other — the intro heading carries the
 * workspace name, which differs the moment a workspace is renamed (or the
 * fallback directory name was used), and treating them as two sections
 * duplicated the template's intro alongside the renamed original.
 */
function headingKey(heading) {
  if (heading !== null && heading.startsWith('## Workspace:')) return '## Workspace:';
  return heading;
}

/**
 * A list entry's merge key: the name of its first backticked `/command`
 * token (`- \`/start-work [handoff|blank]\` — …` → start-work). Two entries
 * with the same name are the same skill, so the template's reworded line
 * replaces the workspace's instead of duplicating it.
 */
function entryKey(line) {
  const m = line.match(/^\s*[-*]\s+`\/([a-z0-9][a-z0-9-]*)[^`]*`/);
  return m ? m[1] : null;
}

function trimTrailingBlanks(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
}

function trimLeadingBlanks(lines) {
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  return lines.slice(start);
}

/**
 * One section's bodies merged: the template's new lines, then the workspace's
 * lines that the template no longer carries (matched by entry name for list
 * entries, by trimmed text otherwise).
 */
function mergeBody(curLines, nxtLines) {
  const nxtKeys = new Set(nxtLines.map(entryKey).filter(Boolean));
  const nxtTrimmed = new Set(nxtLines.map((l) => l.trim()).filter(Boolean));
  const kept = [];
  for (const line of curLines) {
    const key = entryKey(line);
    if (key !== null && nxtKeys.has(key)) continue; // template owns this entry — its line updates ours
    const t = line.trim();
    if (t !== '' && nxtTrimmed.has(t)) continue; // unchanged line, already present
    kept.push(line);
  }
  const body = trimTrailingBlanks(nxtLines);
  return kept.length === 0 ? body : [...body, ...trimLeadingBlanks(trimTrailingBlanks(kept))];
}

function renderBlocks(blocks, eol) {
  const parts = [];
  for (const b of blocks) {
    const body = trimTrailingBlanks(b.lines);
    if (b.heading === null) {
      if (body.length > 0) parts.push(body.join(eol));
    } else {
      parts.push([b.heading, ...body].join(eol));
    }
  }
  return parts.join(eol + eol) + eol;
}

/**
 * Merge an updated template CLAUDE.md (`nextText`, already {{project-name}}-
 * substituted) into the workspace's current one. Template-owned lines take the
 * template's new versions; lines the template doesn't have — the workspace's
 * own skill entries, custom bullets, whole sections — are kept. Sections are
 * matched by heading (`## Workspace:` headings match regardless of name): the
 * result follows the workspace's section order, new template sections are
 * appended at the end, and kept lines land at the end of their section. The
 * output keeps the current file's line endings — CRLF in, CRLF out.
 */
export function mergeClaudeMd(currentText, nextText) {
  const eol = currentText != null && currentText.includes('\r\n') ? '\r\n' : '\n';
  const nxtBlocks = splitBlocks(nextText);
  if (currentText == null || currentText.trim() === '') return renderBlocks(nxtBlocks, eol);
  const nxtByHeading = new Map(nxtBlocks.map((b) => [headingKey(b.heading), b]));
  const used = new Set();
  const out = [];
  for (const cur of splitBlocks(currentText)) {
    const nxt = nxtByHeading.get(headingKey(cur.heading));
    if (nxt) {
      used.add(nxt);
      out.push({ heading: nxt.heading, lines: mergeBody(cur.lines, nxt.lines) });
    } else {
      out.push(cur); // a section the template doesn't have — the workspace's own
    }
  }
  for (const nxt of nxtBlocks) {
    if (!used.has(nxt)) out.push({ heading: nxt.heading, lines: trimTrailingBlanks(nxt.lines) });
  }
  return renderBlocks(out, eol);
}

// ---------- CLI modes ----------

function resolvePayload(args) {
  return resolve(args.payload ?? join(resolve(args.root), '.workspace-update'));
}

function writeBaselineMode(args) {
  const baseline = writeBaseline(args.root, resolvePayload(args));
  process.stdout.write(JSON.stringify({
    written: true,
    path: BASELINE_PATH,
    templateVersion: baseline.templateVersion,
    files: Object.keys(baseline.files).length,
  }, null, 2) + '\n');
}

function mergeClaudeMdMode(args) {
  const absRoot = resolve(args.root);
  const absPayload = resolvePayload(args);
  const tmplPath = join(absPayload, 'CLAUDE.md.tmpl');
  if (!existsSync(tmplPath)) {
    throw new Error(`No CLAUDE.md.tmpl in ${absPayload} — nothing to merge`);
  }
  // The workspace name for {{project-name}} substitution: workspace.json is
  // the source of truth; the directory name is the fallback.
  let name = basename(absRoot);
  try {
    const config = JSON.parse(readFileSync(join(absRoot, 'workspace.json'), 'utf8'));
    if (typeof config?.workspace?.name === 'string' && config.workspace.name) name = config.workspace.name;
  } catch { /* no workspace.json — keep the directory name */ }
  const next = readFileSync(tmplPath, 'utf8').replace(/\{\{project-name\}\}/g, name);
  const claudeMdPath = join(absRoot, 'CLAUDE.md');
  const current = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';
  process.stdout.write(mergeClaudeMd(current, next));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.writeBaseline) {
    writeBaselineMode(args);
  } else if (args.mergeClaudeMd) {
    mergeClaudeMdMode(args);
  } else {
    const result = classifyUpdate({ root: args.root, payload: args.payload });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`classify-update: ${err.message}\n`);
    process.exit(1);
  }
}
