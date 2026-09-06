#!/usr/bin/env node
// Opt-in workspace diagnostics report: how a workspace is actually used, in
// aggregate, so an operator can decide whether to share it (gh:139).
//
// Going to v1.0 means shipping to workspaces nobody can inspect directly.
// This script reads local Claude Code transcripts, the session log, and
// workspace config, and produces a report of usage patterns — skill
// invocations, tool mix, session shape, always-loaded context footprint —
// entirely in aggregate.
//
// THE HARD CONSTRAINT: transcripts are private conversations. This script
// emits counts, not content. It never emits message text, thinking blocks,
// tool inputs or outputs (the one exception is `input.skill`, a bare skill
// name, from Skill tool_use blocks), branch names, session/work-session
// names or slugs, ticket titles, file paths, absolute paths, email
// addresses, or usernames. Where an identifier's cardinality is the
// interesting part, only its count is emitted — identifiers are never
// hashed, since a shared salt makes hashes re-identifiable.
//
// Before writing or printing anything, the generated report text is run
// through scanForLeaks() and refused (exit 2) if it matches an absolute
// path, an email address, a git branch-shaped token, a bare UUID, or the
// current OS username. That scan is the load-bearing safety feature here —
// everything else is best-effort aggregation.
//
// No network calls of any kind. This script only reads local files and
// writes one local report file (or prints to stdout).
//
// Usage:
//   node workspace-diagnostics.mjs --root . --out workspace-scratchpad/diagnostics-report.md
//   node workspace-diagnostics.mjs --root . --json
//
//   --root <path>   workspace root to diagnose (default: .)
//   --out <path>    write markdown report to this path; without it, print
//                   the markdown to stdout
//   --json          emit the raw aggregate object instead of markdown
//   --since <ISO>   optional lower bound on records considered
//
// Data sources (see gh:139 for the full source list):
//   - ~/.claude/projects/<slug>/*.jsonl        — session transcripts
//   - ~/.claude/projects/<slug>/<id>/subagents/agent-*.jsonl — subagent dispatch (counted, never opened)
//   - <root>/workspace-scratchpad/session-log.jsonl — lifecycle event log
//   - <root>/workspace.json                    — templateVersion
//   - ./context-footprint.mjs (measure())      — always-loaded context footprint
//
// Exit codes:
//   0 — report generated (written or printed)
//   1 — argument or filesystem error
//   2 — leak scan refused to emit the report (see stderr for pattern + line)

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), out: null, json: false, since: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--since') args.since = argv[++i];
  }
  return args;
}

// ---------- generic helpers ----------

function readJsonlRecords(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Malformed line — skip rather than throw. Transcripts are written
      // incrementally and a partial final line is expected, not an error.
    }
  }
  return records;
}

/**
 * True when `isoValue` is missing, unparsable, or on/after `sinceDate`.
 * Fails open (keeps the record) rather than dropping data it can't judge —
 * a record with no timestamp is more likely a structural event than one
 * that should be silently excluded by a date filter.
 */
function isAfterOrEqual(isoValue, sinceDate) {
  if (!sinceDate) return true;
  if (typeof isoValue !== 'string') return true;
  const t = Date.parse(isoValue);
  if (Number.isNaN(t)) return true;
  return t >= sinceDate.getTime();
}

function mapToSortedArray(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

function computeMinMedianMax(nums) {
  if (nums.length === 0) return { min: 0, median: 0, max: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}

// ---------- transcripts ----------

/**
 * Derive the ~/.claude/projects/<slug> directory name for a workspace root:
 * the absolute root path with `/` and `.` replaced by `-`.
 */
export function deriveProjectsSlug(absRootPath) {
  return absRootPath.replace(/[/.]/g, '-');
}

/**
 * Resolve the transcripts directory for a workspace root. `claudeHome`
 * defaults to `~/.claude` but is an explicit parameter so tests can point
 * at a fixture instead of the real home directory.
 */
export function resolveProjectsDir(root, claudeHome) {
  const home = claudeHome || join(homedir(), '.claude');
  const slug = deriveProjectsSlug(resolve(root));
  return join(home, 'projects', slug);
}

function listTranscriptFiles(projectsDir) {
  if (!existsSync(projectsDir)) return [];
  let entries;
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(projectsDir, f));
}

/**
 * Count subagent transcript files for one session, without opening them —
 * dispatch count is the metric, not their content.
 */
function countSubagentFiles(projectsDir, sessionId) {
  const dir = join(projectsDir, sessionId, 'subagents');
  if (!existsSync(dir)) return 0;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  return entries.filter((f) => /^agent-.*\.jsonl$/.test(f)).length;
}

/**
 * Walk one transcript file's records (already since-filtered) and extract
 * every aggregate this report needs in a single pass: skill invocations
 * (from Skill tool_use blocks' bare `input.skill` name — the one permitted
 * exception to "never read tool input"), tool-name counts, Claude Code
 * version counts, the set of distinct git branches seen, the count of
 * cwd-to-cwd transitions between consecutive records, and the span of
 * timestamps observed. Never reads message text or thinking blocks.
 */
function analyzeTranscriptFile(filePath, sinceDate) {
  const records = readJsonlRecords(filePath).filter((r) => isAfterOrEqual(r?.timestamp, sinceDate));

  const skillCounts = new Map();
  const toolCounts = new Map();
  const versionCounts = new Map();
  const branches = new Set();
  const timestamps = [];
  let cwdTransitions = 0;
  let hasCwd = false;
  let lastCwd;

  for (const r of records) {
    if (!r || typeof r !== 'object') continue;

    if (typeof r.version === 'string' && r.version) {
      versionCounts.set(r.version, (versionCounts.get(r.version) || 0) + 1);
    }
    if (typeof r.gitBranch === 'string' && r.gitBranch) {
      branches.add(r.gitBranch);
    }
    if (typeof r.timestamp === 'string') {
      const t = Date.parse(r.timestamp);
      if (!Number.isNaN(t)) timestamps.push(t);
    }
    if (typeof r.cwd === 'string') {
      if (hasCwd && r.cwd !== lastCwd) cwdTransitions++;
      lastCwd = r.cwd;
      hasCwd = true;
    }

    if (r.type === 'assistant' && r.message && Array.isArray(r.message.content)) {
      for (const block of r.message.content) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
        if (typeof block.name !== 'string') continue;
        toolCounts.set(block.name, (toolCounts.get(block.name) || 0) + 1);
        if (block.name === 'Skill' && block.input && typeof block.input.skill === 'string') {
          const skillName = block.input.skill;
          skillCounts.set(skillName, (skillCounts.get(skillName) || 0) + 1);
        }
      }
    }
  }

  return {
    recordCount: records.length,
    skillCounts,
    toolCounts,
    versionCounts,
    branches,
    cwdTransitions,
    timestamps,
  };
}

/**
 * Aggregate across every transcript file in `projectsDir`. Returns
 * `{ available: false }` when the directory doesn't exist (rather than
 * throwing) so the report can render an "unavailable" section instead of
 * crashing.
 */
export function aggregateTranscripts({ projectsDir, sinceDate = null }) {
  if (!existsSync(projectsDir)) return { available: false };

  const files = listTranscriptFiles(projectsDir);
  const sessionIds = files.map((f) => basename(f, '.jsonl'));

  const skillCounts = new Map();
  const toolCounts = new Map();
  const versionCounts = new Map();
  const recordCounts = [];
  const perSessionDistinctBranches = [];
  const overallBranches = new Set();
  let cwdTransitionsTotal = 0;
  let subagentDispatches = 0;
  let minTs = null;
  let maxTs = null;

  for (let i = 0; i < files.length; i++) {
    const result = analyzeTranscriptFile(files[i], sinceDate);
    recordCounts.push(result.recordCount);
    cwdTransitionsTotal += result.cwdTransitions;
    perSessionDistinctBranches.push(result.branches.size);
    for (const b of result.branches) overallBranches.add(b);
    for (const [k, v] of result.skillCounts) skillCounts.set(k, (skillCounts.get(k) || 0) + v);
    for (const [k, v] of result.toolCounts) toolCounts.set(k, (toolCounts.get(k) || 0) + v);
    for (const [k, v] of result.versionCounts) versionCounts.set(k, (versionCounts.get(k) || 0) + v);
    for (const t of result.timestamps) {
      if (minTs === null || t < minTs) minTs = t;
      if (maxTs === null || t > maxTs) maxTs = t;
    }
    subagentDispatches += countSubagentFiles(projectsDir, sessionIds[i]);
  }

  const daysSpanned = minTs !== null ? Math.floor((maxTs - minTs) / 86400000) + 1 : 0;

  return {
    available: true,
    transcriptCount: files.length,
    recordCountStats: computeMinMedianMax(recordCounts),
    distinctBranchCount: {
      overall: overallBranches.size,
      perSession: perSessionDistinctBranches,
    },
    cwdTransitions: cwdTransitionsTotal,
    subagentDispatches,
    skillCounts: mapToSortedArray(skillCounts),
    toolCounts: mapToSortedArray(toolCounts),
    versionCounts: mapToSortedArray(versionCounts),
    dateRange: {
      minIso: minTs !== null ? new Date(minTs).toISOString() : null,
      maxIso: maxTs !== null ? new Date(maxTs).toISOString() : null,
      daysSpanned,
    },
  };
}

// ---------- available skills (for zero-invocation call-out) ----------

/**
 * List skill directory names under <root>/.claude/skills. Each subdirectory
 * is one skill (holding a SKILL.md). Reading this directory is safe to
 * report on — it's the framework's own skill catalog, not user content.
 */
export function listAvailableSkills(root) {
  const dir = join(root, '.claude', 'skills');
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

// ---------- session log ----------

/**
 * Aggregate <root>/workspace-scratchpad/session-log.jsonl by `event` and
 * `reason`. Never reads or emits `user`, `session_id`, `workspace_branch`,
 * or `work_session` from those records.
 */
export function aggregateSessionLog(root, sinceDate = null) {
  const path = join(root, 'workspace-scratchpad', 'session-log.jsonl');
  if (!existsSync(path)) return { available: false };

  const records = readJsonlRecords(path).filter((r) => isAfterOrEqual(r?.date, sinceDate));
  const eventCounts = new Map();
  const reasonCounts = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.event === 'string' && r.event) {
      eventCounts.set(r.event, (eventCounts.get(r.event) || 0) + 1);
    }
    if (typeof r.reason === 'string' && r.reason) {
      reasonCounts.set(r.reason, (reasonCounts.get(r.reason) || 0) + 1);
    }
  }
  return {
    available: true,
    totalRecords: records.length,
    eventCounts: mapToSortedArray(eventCounts),
    reasonCounts: mapToSortedArray(reasonCounts),
  };
}

// ---------- workspace config ----------

export function readTemplateVersion(root) {
  const path = join(root, 'workspace.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed?.workspace?.templateVersion ?? null;
  } catch {
    return null;
  }
}

// ---------- always-loaded footprint ----------

/**
 * Load and run context-footprint.mjs's measure({ root }). That module is
 * being written in parallel and may not exist yet, may not export
 * `measure`, or may throw — all three are reported as "unavailable" with a
 * reason rather than crashing this script.
 */
export async function loadFootprint(root) {
  let mod;
  try {
    mod = await import(new URL('./context-footprint.mjs', import.meta.url));
  } catch {
    return { available: false, reason: 'context-footprint.mjs not found (being developed in parallel)' };
  }
  if (typeof mod.measure !== 'function') {
    return { available: false, reason: 'context-footprint.mjs does not export measure()' };
  }
  try {
    const data = mod.measure({ root });
    return { available: true, data };
  } catch (err) {
    return { available: false, reason: `measure() threw: ${err.message}` };
  }
}

// ---------- report assembly ----------

/**
 * Build the full diagnostics aggregate for `root`. Pure aside from the
 * dynamic footprint import: reads files at explicit, injectable paths and
 * never falls back to process.cwd(), so it behaves identically regardless
 * of the caller's current directory.
 */
export async function buildReport({ root, since = null, claudeHome } = {}) {
  const absRoot = resolve(root);
  const sinceDate = since ? new Date(since) : null;

  const templateVersion = readTemplateVersion(absRoot);
  const projectsDir = resolveProjectsDir(absRoot, claudeHome);
  const transcripts = aggregateTranscripts({ projectsDir, sinceDate });
  const zeroInvocationSkills = transcripts.available
    ? listAvailableSkills(absRoot).filter(
        (name) => !transcripts.skillCounts.some((s) => s.name === name),
      )
    : [];
  const sessionLog = aggregateSessionLog(absRoot, sinceDate);
  const footprint = await loadFootprint(absRoot);

  return {
    generatedAt: new Date().toISOString(),
    since: since || null,
    templateVersion,
    transcripts,
    zeroInvocationSkills,
    sessionLog,
    footprint,
  };
}

export function renderMarkdown(agg) {
  const lines = [];
  lines.push('# Workspace Diagnostics Report', '');
  lines.push(`Generated: ${agg.generatedAt}`);
  if (agg.since) lines.push(`Since: ${agg.since}`);
  lines.push('');

  lines.push('## Environment', '');
  lines.push(`- Template version: ${agg.templateVersion ?? '_unknown_'}`);
  if (agg.transcripts.available) {
    if (agg.transcripts.versionCounts.length > 0) {
      lines.push('- Claude Code versions seen (record count):');
      for (const v of agg.transcripts.versionCounts) lines.push(`  - ${v.name}: ${v.count}`);
    } else {
      lines.push('- Claude Code versions seen: _none recorded_');
    }
    if (agg.transcripts.dateRange.minIso) {
      lines.push(
        `- Date range covered: ${agg.transcripts.dateRange.minIso} to ${agg.transcripts.dateRange.maxIso} (${agg.transcripts.dateRange.daysSpanned} days spanned)`,
      );
    } else {
      lines.push('- Date range covered: _no timestamped records_');
    }
  } else {
    lines.push('- Transcript data: _unavailable — no projects directory found for this workspace_');
  }
  lines.push('');

  lines.push('## Skill Usage', '');
  if (agg.transcripts.available) {
    if (agg.transcripts.skillCounts.length === 0) {
      lines.push('_No skill invocations recorded._');
    } else {
      lines.push('| Skill | Invocations |', '|---|---|');
      for (const s of agg.transcripts.skillCounts) lines.push(`| ${s.name} | ${s.count} |`);
    }
    if (agg.zeroInvocationSkills.length > 0) {
      lines.push('', `**Never invoked (the finding):** ${agg.zeroInvocationSkills.join(', ')}`);
    }
  } else {
    lines.push('_Unavailable — transcript data not found._');
  }
  lines.push('');

  lines.push('## Session Shape', '');
  if (agg.transcripts.available) {
    const stats = agg.transcripts.recordCountStats;
    const branchInfo = agg.transcripts.distinctBranchCount;
    const perSessionMin = branchInfo.perSession.length > 0 ? Math.min(...branchInfo.perSession) : 0;
    const perSessionMax = branchInfo.perSession.length > 0 ? Math.max(...branchInfo.perSession) : 0;
    lines.push(`- Transcript (session) count: ${agg.transcripts.transcriptCount}`);
    lines.push(`- Records per session — min: ${stats.min}, median: ${stats.median}, max: ${stats.max}`);
    lines.push(
      `- Distinct branches — overall: ${branchInfo.overall} (per-session range: ${perSessionMin}–${perSessionMax})`,
    );
    lines.push(`- cwd transitions (total across sessions): ${agg.transcripts.cwdTransitions}`);
    lines.push(`- Subagent dispatches (total): ${agg.transcripts.subagentDispatches}`);
  } else {
    lines.push('_Unavailable — transcript data not found._');
  }
  lines.push('');

  lines.push('## Tool Mix', '');
  if (agg.transcripts.available) {
    if (agg.transcripts.toolCounts.length === 0) {
      lines.push('_No tool invocations recorded._');
    } else {
      lines.push('| Tool | Invocations |', '|---|---|');
      for (const t of agg.transcripts.toolCounts.slice(0, 15)) lines.push(`| ${t.name} | ${t.count} |`);
    }
  } else {
    lines.push('_Unavailable — transcript data not found._');
  }
  lines.push('');

  lines.push('## Always-Loaded Footprint', '');
  if (agg.footprint.available) {
    const f = agg.footprint.data || {};
    lines.push(`- Total bytes: ${f.totalBytes}`);
    lines.push(`- Total tokens: ${f.totalTokens}`);
    lines.push(`- Percent of context window: ${f.percentOfWindow}`);
    if (Array.isArray(f.missingImports) && f.missingImports.length > 0) {
      lines.push(`- Missing imports: ${f.missingImports.length}`);
    }
    if (typeof f.local === 'boolean') {
      lines.push(`- Local: ${f.local}`);
    }
    if (Array.isArray(f.files) && f.files.length > 0) {
      lines.push('', '| File | Bytes | Kind |', '|---|---|---|');
      for (const file of f.files) lines.push(`| ${file.path} | ${file.bytes} | ${file.kind} |`);
    }
  } else {
    lines.push(`_Unavailable — ${agg.footprint.reason}._`);
  }
  lines.push('');

  lines.push('## Session Log', '');
  if (agg.sessionLog.available) {
    lines.push('Events:');
    if (agg.sessionLog.eventCounts.length === 0) {
      lines.push('_none recorded_');
    } else {
      for (const e of agg.sessionLog.eventCounts) lines.push(`- ${e.name}: ${e.count}`);
    }
    lines.push('', 'Reasons:');
    if (agg.sessionLog.reasonCounts.length === 0) {
      lines.push('_none recorded_');
    } else {
      for (const r of agg.sessionLog.reasonCounts) lines.push(`- ${r.name}: ${r.count}`);
    }
  } else {
    lines.push('_Unavailable — no session-log.jsonl found._');
  }
  lines.push('');

  return lines.join('\n');
}

// ---------- leak scan (the load-bearing safety feature) ----------
//
// Deliberate tension, spelled out: the "Always-Loaded Footprint" table
// emits `files[].path` values, which are framework-relative paths like
// `.claude/rules/git-conventions.md` — safe, since they describe the
// template's own file layout, not user content. What must never appear is
// an ABSOLUTE path, which would anchor that same file to one operator's
// home directory. The regex below only matches the absolute forms.

const ABS_PATH_RE = /(\/Users\/[^\s`)]+|\/home\/[^\s`)]+|[A-Za-z]:\\[^\s`)]+)/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const BRANCH_RE = /(feature|bugfix|chore|release|hotfix)\/[A-Za-z0-9][A-Za-z0-9._-]*/;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;

/**
 * Scan `text` for patterns that must never appear in a diagnostics report.
 * `username` is injectable (defaults to the real OS username) so tests can
 * exercise the username check deterministically. Returns an array of
 * `{ pattern, line, excerpt }` — empty when clean.
 */
export function scanForLeaks(text, { username } = {}) {
  const effectiveUsername = username !== undefined ? username : userInfo().username;
  const patterns = [
    { pattern: 'absolute-path', re: ABS_PATH_RE },
    { pattern: 'email-address', re: EMAIL_RE },
    { pattern: 'git-branch-token', re: BRANCH_RE },
    { pattern: 'uuid', re: UUID_RE },
  ];
  if (typeof effectiveUsername === 'string' && effectiveUsername.trim().length > 0) {
    const escaped = effectiveUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push({ pattern: 'os-username', re: new RegExp(`\\b${escaped}\\b`) });
  }

  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, re } of patterns) {
      const match = line.match(re);
      if (match) {
        hits.push({ pattern, line: i + 1, excerpt: line.trim().slice(0, 200) });
      }
    }
  }
  return hits;
}

// ---------- CLI entry point ----------

async function main() {
  const args = parseArgs(process.argv);

  if (args.since) {
    const parsed = new Date(args.since);
    if (Number.isNaN(parsed.getTime())) {
      process.stderr.write(`error: --since value is not a valid date: ${args.since}\n`);
      process.exit(1);
    }
  }

  const aggregate = await buildReport({ root: args.root, since: args.since });
  const outputText = args.json ? JSON.stringify(aggregate, null, 2) : renderMarkdown(aggregate);

  const leaks = scanForLeaks(outputText);
  if (leaks.length > 0) {
    process.stderr.write('workspace-diagnostics: refusing to emit — potential privacy leak detected:\n');
    for (const hit of leaks) {
      process.stderr.write(`  [${hit.pattern}] line ${hit.line}: ${hit.excerpt}\n`);
    }
    process.exit(2);
  }

  const finalText = outputText.endsWith('\n') ? outputText : `${outputText}\n`;
  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, finalText);
    process.stdout.write(`${outPath}\n`);
  } else {
    process.stdout.write(finalText);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

export {
  parseArgs,
  isAfterOrEqual,
  mapToSortedArray,
  computeMinMedianMax,
};
