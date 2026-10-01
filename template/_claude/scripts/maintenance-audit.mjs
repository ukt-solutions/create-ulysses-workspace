#!/usr/bin/env node
// Scripted workspace audit: the mechanical, read-only checks of /maintenance
// Audit sections 1–7 in one shot (gh:180), from a workspace root or from the
// upgrade payload.
//
// Running those sections as prose made the audit slow, variable between runs,
// and impossible to reuse for post-update verification. This script owns the
// parts a program can decide:
//
//   1. cross-reference  — skills vs the CLAUDE.md skill list (both
//                         directions), dangling @-imports in CLAUDE.md's
//                         import graph
//   2. frontmatter      — workspace-context/*.md and session trackers parse,
//                         reference live branches/repos, and are not stale
//   3. structure        — workspace.json and CLAUDE.md present and parseable,
//                         manifest repos cloned, expected directories there
//   4. git              — launcher on its default branch, clean tracked tree
//   5. auto-files       — workspace-context catalogs current (the same
//                         semantics as build-workspace-context.mjs --check)
//   6. budget           — always-loaded context within
//                         workspace.alwaysLoadedBudgetBytes
//   7. freshness        — template version vs the npm registry
//
// Severity, and what each means for the exit code:
//   issue   — broken references, unparseable files, structural violations:
//             something that must be fixed. Any issue → exit 1.
//   warning — state drift a human should look at (uncommitted changes,
//             stale context, over budget) that breaks nothing.
//   info    — expected or ambient conditions (machine-local files absent,
//             optional stubs, untracked paths).
//
// Rather than re-implementing, the checks reuse the shipped helpers:
// context-footprint.mjs (measure/readBudget/resolveImports) for sections 1
// and 6, build-workspace-context.mjs (regenerateAll/fingerprint) for section
// 5, lib/freshness.mjs (refreshIfStale) for section 7. Only git runs as a
// subprocess, always with an argv array.
//
// Section 7 is the one network user, and refreshIfStale also rewrites the
// local-only-template-freshness.md banner and the version cache — the same
// writes /maintenance section 7 has always made. --offline skips it.
//
// Usage:
//   node maintenance-audit.mjs [--root <dir>] [--json] [--offline]
//                              [--changed <path-or-list-file>]...
//
//   --root <dir>   workspace root; defaults to the current working directory.
//                  Never derived from this script's location — the upgrade
//                  payload runs this file from
//                  <workspace>/.workspace-update/.claude/scripts/.
//   --json         emit { issues: [{section,severity,file,message,
//                  fromUpdate?}], summary } instead of the human report
//   --offline      skip section 7 (no network, no banner/cache writes)
//   --changed      mark findings whose file is in the list with
//                  fromUpdate: true ("(from this update)" in text). The value
//                  is one path, or a file containing a newline-separated path
//                  list (recognized when the value names an existing file
//                  whose every non-empty line is whitespace-free). Repeatable.
//
// Exit codes: 0 — no issue-severity findings; 1 — at least one; 2 — argument
// or filesystem error before any check ran.

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measure, readBudget, resolveImports } from './context-footprint.mjs';
import { regenerateAll, fingerprint, gitIgnoredPaths } from './build-workspace-context.mjs';
import { refreshIfStale } from '../lib/freshness.mjs';
import { parseSessionContent } from '../lib/session-frontmatter.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const SECTIONS = [
  { key: 'cross-reference', n: 1, label: 'Cross-references', ok: 'skills and @-imports consistent with CLAUDE.md' },
  { key: 'frontmatter', n: 2, label: 'Frontmatter', ok: 'context files parse and reference live branches and repos' },
  { key: 'structure', n: 3, label: 'Workspace structure', ok: 'layout matches the workspace structure' },
  { key: 'git', n: 4, label: 'Git state', ok: 'on the default branch, tracked tree clean' },
  { key: 'auto-files', n: 5, label: 'Context auto-files', ok: 'index.md and canonical.md current' },
  { key: 'budget', n: 6, label: 'Always-loaded budget', ok: '' },
  { key: 'freshness', n: 7, label: 'Template freshness', ok: '' },
];

const STALE_DAYS = 7;
const KB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function toPosix(p) {
  return p.split(sep).join('/');
}

/** Normalize a possibly-relative, possibly-absolute path against the root. */
function toRootRelative(absRoot, value) {
  const rel = relative(absRoot, resolve(absRoot, value));
  return rel.startsWith('..') ? toPosix(value) : toPosix(rel);
}

function isAutoFileRel(rel, wcDir) {
  return rel === `${wcDir}/index.md`
    || rel === `${wcDir}/canonical.md`
    || new RegExp(`^${wcDir}/team-member/[^/]+/index\\.md$`).test(rel);
}

/** Extract one `## heading` section, or null when the heading is absent. */
function extractHeadingSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * Run the audit. Returns { issues, summary }; throws only on filesystem
 * errors that make the whole run impossible, never for what it finds.
 * fetchFn/nowFn are injectable so tests never touch the network or the wall
 * clock.
 */
export async function runAudit({
  root = '.',
  changed = [],
  offline = false,
  fetchFn = fetch,
  nowFn = () => new Date(),
} = {}) {
  const absRoot = resolve(root);
  const changedSet = new Set(changed.map((c) => toRootRelative(absRoot, c)));
  const findings = [];
  const add = (section, severity, file, message) => findings.push({
    section,
    severity,
    file,
    message,
    ...(changedSet.has(file) ? { fromUpdate: true } : {}),
  });

  // ---------- shared inputs ----------

  let wsConfig = null;
  const wsJsonPath = join(absRoot, 'workspace.json');
  if (existsSync(wsJsonPath)) {
    try {
      wsConfig = JSON.parse(readFileSync(wsJsonPath, 'utf8'));
    } catch (err) {
      add('structure', 'issue', 'workspace.json', `workspace.json does not parse: ${err.message}`);
    }
  }
  const ws = wsConfig?.workspace && typeof wsConfig.workspace === 'object' ? wsConfig.workspace : {};
  const reposManifest = wsConfig?.repos && typeof wsConfig.repos === 'object' ? wsConfig.repos : {};
  const wcDir = typeof ws.workspaceContextDir === 'string' && ws.workspaceContextDir ? ws.workspaceContextDir : 'workspace-context';
  const sessionsDir = typeof ws.workSessionsDir === 'string' && ws.workSessionsDir ? ws.workSessionsDir : 'work-sessions';

  const git = (args) => spawnSync('git', args, { cwd: absRoot, encoding: 'utf8' });
  const gitInfo = (() => {
    const inside = git(['rev-parse', '--is-inside-work-tree']);
    if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') return { isRepo: false };
    const cur = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = cur.status === 0 ? cur.stdout.trim() : null;
    // The launcher's default branch: the remote's HEAD when there is one
    // (origin/main → main), else the configured init default, else main.
    let defaultBranch = null;
    const sym = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (sym.status === 0 && sym.stdout.trim()) {
      const parts = sym.stdout.trim().split('/');
      defaultBranch = parts.slice(1).join('/') || parts[0];
    } else {
      const cfg = git(['config', '--get', 'init.defaultBranch']);
      defaultBranch = cfg.status === 0 && cfg.stdout.trim() ? cfg.stdout.trim() : 'main';
    }
    const status = git(['status', '--porcelain']);
    const porcelain = status.status === 0
      ? status.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      : [];
    const branches = git(['branch', '--all', '--format=%(refname:short)']);
    return {
      isRepo: true,
      branch,
      defaultBranch,
      porcelain,
      branches: new Set(branches.status === 0 ? branches.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []),
    };
  })();

  // ---------- 3. structure ----------

  if (!existsSync(wsJsonPath)) add('structure', 'issue', 'workspace.json', 'workspace.json is missing');
  if (!existsSync(join(absRoot, 'CLAUDE.md'))) {
    add('structure', 'issue', 'CLAUDE.md', 'CLAUDE.md is missing — cross-reference checks skipped');
  }
  if (!existsSync(join(absRoot, wcDir))) {
    add('structure', 'warning', wcDir, `${wcDir}/ does not exist — team knowledge lives there`);
  }
  for (const dir of ['rules', 'skills', 'scripts']) {
    if (!existsSync(join(absRoot, '.claude', dir))) {
      add('structure', 'warning', `.claude/${dir}`, `.claude/${dir}/ does not exist — the workspace structure expects it`);
    }
  }
  for (const name of Object.keys(reposManifest)) {
    if (!existsSync(join(absRoot, 'repos', name))) {
      add('structure', 'warning', 'workspace.json', `repo '${name}' is in the manifest but repos/${name}/ is not cloned`);
    }
  }

  // ---------- 1. cross-reference ----------

  const claudeMdPath = join(absRoot, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const text = readFileSync(claudeMdPath, 'utf8');
    const skillsDir = join(absRoot, '.claude', 'skills');
    const installed = existsSync(skillsDir)
      ? readdirSync(skillsDir).filter((n) => {
        try { return statSync(join(skillsDir, n)).isDirectory(); } catch { return false; }
      }).sort()
      : [];

    const skillsSection = extractHeadingSection(text, 'Skills');
    const listed = new Set();
    if (skillsSection !== null) {
      for (const m of skillsSection.matchAll(/`\/([a-z0-9][a-z0-9-]*)/g)) listed.add(m[1]);
    }
    for (const name of installed) {
      const isListed = skillsSection !== null ? listed.has(name) : text.includes(`/${name}`);
      if (!isListed) {
        add('cross-reference', 'issue', `.claude/skills/${name}/SKILL.md`,
          `skill /${name} is installed but not listed in CLAUDE.md — sessions cannot discover it`);
      }
    }
    for (const name of listed) {
      if (!installed.includes(name)) {
        add('cross-reference', 'issue', 'CLAUDE.md', `CLAUDE.md lists /${name} but .claude/skills/${name}/ does not exist`);
      }
    }

    // Dangling @-imports across CLAUDE.md's import graph.
    const missing = [];
    resolveImports(claudeMdPath, new Set([claudeMdPath]), missing);
    for (const spec of missing) {
      const posix = toPosix(spec);
      const base = posix.split('/').pop();
      if (base.startsWith('local-only-')) {
        add('cross-reference', 'info', 'CLAUDE.md', `@${posix} is absent — machine-local, expected on other machines`);
      } else if (posix === 'CODEBASE.md') {
        add('cross-reference', 'info', 'CLAUDE.md', '@CODEBASE.md is absent — optional stub, /workspace-init generates it on request');
      } else if (isAutoFileRel(posix, wcDir)) {
        continue; // section 5 owns the auto-generated artifacts
      } else {
        add('cross-reference', 'issue', 'CLAUDE.md', `@${posix} is imported by CLAUDE.md but does not exist`);
      }
    }
  }

  // ---------- 2. frontmatter ----------

  (() => {
    const files = [];
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        let st; try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && name.endsWith('.md')) files.push(full);
      }
    };
    walk(join(absRoot, wcDir));
    const sessionsRoot = join(absRoot, sessionsDir);
    if (existsSync(sessionsRoot)) {
      for (const name of readdirSync(sessionsRoot).sort()) {
        const tracker = join(sessionsRoot, name, 'workspace', 'session.md');
        if (existsSync(tracker)) files.push(tracker);
      }
    }
    if (files.length === 0) return; // a missing wcDir is section 3's finding

    const rels = files.map((f) => toPosix(relative(absRoot, f)));
    // Reuses build-workspace-context's batched check-ignore: gitignored .md
    // files are machine-local (local-only-* drafts, per-user indexes) and
    // not audited. No git → empty set → everything local gets audited.
    const ignored = gitIgnoredPaths(absRoot, rels);

    for (let i = 0; i < files.length; i++) {
      const rel = rels[i];
      if (ignored.has(rel)) continue;
      if (rel.split('/').pop().startsWith('local-only-')) continue;
      if (isAutoFileRel(rel, wcDir)) continue;

      const content = readFileSync(files[i], 'utf8');
      const isTracker = rel.startsWith(`${sessionsDir}/`) && rel.endsWith('/workspace/session.md');
      if (!content.startsWith('---')) {
        add('frontmatter', 'warning', rel, 'no YAML frontmatter — workspace-context files carry it by convention');
        continue;
      }
      let parsed;
      try {
        parsed = parseSessionContent(content);
      } catch (err) {
        add('frontmatter', 'issue', rel, `frontmatter does not parse: ${err.message}`);
        continue;
      }
      const f = parsed.fields;

      if (isTracker) {
        for (const key of ['name', 'status', 'branch']) {
          if (!f[key]) add('frontmatter', 'warning', rel, `session tracker is missing its '${key}' field`);
        }
      }
      if (typeof f.branch === 'string' && f.branch && gitInfo.isRepo && !gitInfo.branches.has(f.branch)) {
        add('frontmatter', 'warning', rel, `branch '${f.branch}' no longer exists`);
      }
      const repoRefs = [];
      if (typeof f.repo === 'string') repoRefs.push(f.repo);
      if (typeof f.repos === 'string') repoRefs.push(f.repos);
      for (const r of Array.isArray(f.repos) ? f.repos : []) {
        if (typeof r === 'string') repoRefs.push(r);
        else if (r && typeof r === 'object' && typeof r.repo === 'string') repoRefs.push(r.repo);
      }
      for (const r of repoRefs) {
        if (r !== '.' && !(r in reposManifest)) {
          add('frontmatter', 'warning', rel, `references repo '${r}' which is not in workspace.json`);
        }
      }
      if (f.lifecycle === 'active' && typeof f.updated === 'string') {
        const t = Date.parse(f.updated);
        if (!Number.isNaN(t)) {
          const ageDays = (nowFn().getTime() - t) / 86400000;
          if (ageDays > STALE_DAYS) {
            add('frontmatter', 'warning', rel,
              `lifecycle active but not updated in ${Math.floor(ageDays)} days — stale candidate`);
          }
        }
      }
      if (f.lifecycle === 'resolved') {
        add('frontmatter', 'info', rel, 'lifecycle resolved — confirm /complete-work has processed it');
      }
      if ('confidence' in f && !['high', 'medium', 'low'].includes(f.confidence)) {
        add('frontmatter', 'warning', rel, `confidence '${f.confidence}' is not one of high, medium, low`);
      }
    }
  })();

  // ---------- 4. git state ----------

  if (!gitInfo.isRepo) {
    add('git', 'info', '.', 'not a git repository — git checks skipped');
  } else {
    if (gitInfo.branch === 'HEAD') {
      add('git', 'warning', '.', 'detached HEAD — the launcher sits on its default branch');
    } else if (gitInfo.branch !== gitInfo.defaultBranch) {
      add('git', 'warning', '.',
        `on branch '${gitInfo.branch}' — the launcher stays on its default branch ('${gitInfo.defaultBranch}')`);
    }
    const dirty = gitInfo.porcelain.filter((l) => !l.startsWith('??'));
    const untracked = gitInfo.porcelain.filter((l) => l.startsWith('??'));
    if (dirty.length > 0) {
      // Porcelain is "XY <path>" (the leading X is a space for unstaged
      // changes, and the line was trimmed), so the path starts after the
      // first space.
      const paths = dirty.slice(0, 5).map((l) => l.slice(l.indexOf(' ') + 1).replace(/ -> /, ' → '));
      add('git', 'warning', '.',
        `${dirty.length} tracked file(s) with uncommitted changes: ${paths.join(', ')}${dirty.length > 5 ? ', …' : ''}`);
    }
    if (untracked.length > 0) {
      add('git', 'info', '.', `${untracked.length} untracked path(s) — gitignored content is not counted`);
    }
  }

  // ---------- 5. auto-files ----------

  let canonicalSel = null;
  (() => {
    let artifacts;
    try {
      artifacts = regenerateAll(absRoot);
    } catch (err) {
      add('auto-files', 'issue', `${wcDir}/`, `catalog build failed: ${err.message}`);
      return;
    }
    if (artifacts.length === 0) return; // a missing wcDir is section 3's finding
    for (const a of artifacts) {
      const rel = toPosix(relative(absRoot, a.path));
      if (!existsSync(a.path)) {
        // Mirrors build-workspace-context --check: a gitignored artifact
        // (per-user indexes) is regenerated per machine, so its absence is
        // the normal fresh-checkout state, not staleness.
        const gitignored = gitInfo.isRepo
          ? spawnSync('git', ['-C', absRoot, 'check-ignore', '-q', rel]).status === 0
          : false;
        if (gitignored) {
          add('auto-files', 'info', rel, `${a.label} is absent — gitignored, regenerated on demand`);
        } else {
          add('auto-files', 'issue', rel,
            `${a.label} is missing — run node .claude/scripts/build-workspace-context.mjs --write`);
        }
        continue;
      }
      if (fingerprint(readFileSync(a.path, 'utf8')) !== fingerprint(a.content)) {
        add('auto-files', 'issue', rel,
          `${a.label} is stale — run node .claude/scripts/build-workspace-context.mjs --write`);
      }
      if (a.label === 'canonical.md') canonicalSel = a.selection;
    }
    if (canonicalSel) {
      if (canonicalSel.status === 'over-budget') {
        add('auto-files', 'warning', `${wcDir}/canonical.md`,
          `canonical body exceeds its budget by ${canonicalSel.overBy} bytes after trimming and stubbing — triage via /maintenance cleanup`);
      } else if (canonicalSel.trimmedFiles.length + canonicalSel.stubbedFiles.length > 0) {
        add('auto-files', 'info', `${wcDir}/canonical.md`,
          `canonical fits its budget with ${canonicalSel.trimmedFiles.length} trimmed and ${canonicalSel.stubbedFiles.length} stubbed reference file(s)`);
      }
    }
  })();

  // ---------- 6. always-loaded budget ----------

  let alwaysLoaded = null;
  try {
    const m = measure({ root: absRoot });
    const budgetBytes = readBudget(absRoot);
    alwaysLoaded = {
      totalBytes: m.totalBytes,
      budgetBytes,
      overBudget: budgetBytes !== null && m.totalBytes > budgetBytes,
    };
    if (alwaysLoaded.overBudget) {
      const top = m.files.slice(0, 3).map((f) => `${f.path} (${KB(f.bytes)})`).join(', ');
      add('budget', 'warning', '.',
        `always-loaded context ${m.totalBytes}/${budgetBytes} bytes — top contributors: ${top}`);
    }
  } catch {
    // measure/readBudget throw only on unreadable or malformed inputs the
    // structure section has already reported; nothing to add here.
  }

  // ---------- 7. freshness ----------

  let freshness = null;
  if (offline) {
    freshness = { status: 'skipped', reason: 'offline' };
  } else {
    const r = await refreshIfStale({ workspaceRoot: absRoot, ttlMs: 24 * 60 * 60 * 1000, fetchFn });
    if (r.status === 'outdated') {
      add('freshness', 'warning', 'workspace.json',
        `template v${r.current} → v${r.latest} available — run npx @ulysses-ai/create-workspace --upgrade`);
    } else if (r.status === 'unknown') {
      add('freshness', 'warning', 'workspace.json', 'could not reach the npm registry — template freshness unknown');
    } else if (r.skipped === 'uninitialized') {
      add('freshness', 'info', 'workspace.json', 'workspace not initialized — freshness check unavailable');
    }
    freshness = r.skipped ? { status: 'skipped', reason: r.skipped } : r;
  }

  const count = (severity) => findings.filter((f) => f.severity === severity).length;
  return {
    issues: findings,
    summary: {
      root: absRoot,
      issues: count('issue'),
      warnings: count('warning'),
      infos: count('info'),
      alwaysLoaded,
      canonical: canonicalSel
        ? { status: canonicalSel.status, budget: canonicalSel.budgetBytes, current: canonicalSel.currentBytes }
        : null,
      freshness,
      exitCode: count('issue') > 0 ? 1 : 0,
    },
  };
}

export function renderReport({ issues, summary }) {
  const marks = { issue: '✗', warning: '⚠', info: 'ℹ' };
  const lines = [`Workspace audit — ${summary.root}`, ''];
  for (const sec of SECTIONS) {
    lines.push(`${sec.n}. ${sec.label}`);
    const found = issues.filter((f) => f.section === sec.key);
    if (found.length > 0) {
      for (const f of found) {
        lines.push(`   ${marks[f.severity]} ${f.file}: ${f.message}${f.fromUpdate ? ' (from this update)' : ''}`);
      }
    } else if (sec.key === 'budget') {
      lines.push(summary.alwaysLoaded && summary.alwaysLoaded.budgetBytes !== null
        ? `   ✓ Always-loaded context: ${KB(summary.alwaysLoaded.totalBytes)} / ${KB(summary.alwaysLoaded.budgetBytes)}`
        : '   ✓ Always-loaded context: no budget set (workspace.alwaysLoadedBudgetBytes absent)');
    } else if (sec.key === 'freshness') {
      const fr = summary.freshness;
      if (fr && fr.status === 'current') lines.push(`   ✓ Template is up to date (v${fr.latest}).`);
      else lines.push(`   - skipped (--offline)`);
    } else {
      lines.push(`   ✓ ${sec.ok}`);
    }
    lines.push('');
  }
  lines.push(
    `Result: ${summary.issues} issue(s), ${summary.warnings} warning(s), ${summary.infos} info — exit ${summary.exitCode}`,
  );
  return lines.join('\n');
}

export function parseArgs(argv) {
  const args = { root: process.cwd(), json: false, offline: false, changed: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--offline') args.offline = true;
    else if (a === '--changed') args.changed.push(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/**
 * Expand --changed values into root-relative posix paths. A value naming an
 * existing file whose every non-empty line is whitespace-free is read as a
 * newline-separated path list; anything else is one path.
 */
function expandChanged(absRoot, values) {
  const out = new Set();
  for (const value of values) {
    let readAsList = false;
    if (typeof value === 'string' && value.length > 0) {
      let st; try { st = statSync(value); } catch { st = null; }
      if (st?.isFile()) {
        const lines = readFileSync(value, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0 && lines.every((l) => /^\S+$/.test(l))) {
          for (const l of lines) out.add(toRootRelative(absRoot, l));
          readAsList = true;
        }
      }
    }
    if (!readAsList) out.add(toRootRelative(absRoot, value));
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const absRoot = resolve(args.root);
  const changed = expandChanged(absRoot, args.changed);
  const result = await runAudit({ root: absRoot, changed: [...changed], offline: args.offline });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderReport(result) + '\n');
  }
  process.exitCode = result.summary.exitCode;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`maintenance-audit: ${err.message}\n`);
    process.exit(2);
  });
}
