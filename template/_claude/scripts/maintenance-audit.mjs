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
//   2. frontmatter      — live workspace-context/*.md and session trackers
//                         parse, reference live branches/repos, and are not
//                         stale. Historical material (paths the indexer's
//                         .indexignore excludes, anything under an archive/
//                         directory) and closed-out lifecycles are skipped
//   3. structure        — workspace.json and CLAUDE.md present and parseable,
//                         manifest repos cloned, expected directories there,
//                         and the template-modification registry sane:
//                         legacy workspace.json keys and registrations the
//                         workspace abandoned are info, a registry that
//                         doesn't parse is a warning (gh:194)
//   4. git              — launcher on its default branch with a clean tracked
//                         tree. Audited from a linked worktree (task or
//                         session), the launcher-level questions — the
//                         launcher's branch and dirty tree, manifest repos
//                         cloned — are asked against the launcher (the parent
//                         of the git common dir), while the worktree's own
//                         branch is only named in an info line and its dirty
//                         tracked tree is skipped as info: in-flight work, not
//                         drift (gh:183). The launcher's
//                         .claude/skills/workspace-update/ modification an
//                         --upgrade leaves when its content equals the staged
//                         payload's is the expected bootstrap, reported as
//                         info, never a dirty-tree warning (gh:190)
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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measure, readBudget, resolveImports } from './context-footprint.mjs';
import {
  regenerateAll,
  fingerprint,
  gitIgnoredPaths,
  readIgnorePrefixes,
  isIgnored,
} from './build-workspace-context.mjs';
import { hashBytes, readBaseline } from './template-baseline.mjs';
import { readTemplateModifications } from './template-modifications.mjs';
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
  // Identical findings are reported once (gh:180 fix round): a file reached
  // through two walk roots — e.g. a session tracker living inside the
  // workspace-context tree — must not double-report. (The dogfood run's
  // apparent duplicates were subtler still: one release branch is referenced
  // by both its notes-* and questions-* archive artifacts, so the same
  // message appeared under two file paths. Scoping section 2 to live content
  // removes those; this guard removes the exact kind.) The key is a JSON
  // array — a structural delimiter, never a byte that could appear in the
  // values (NUL separators made git treat this file as binary).
  const seenFindings = new Set();
  // opts.noFromUpdate: expected-absent findings (a machine-local import
  // missing inside a task worktree) stay ambient info even when their file
  // is on the --changed list — the update did not cause them (gh:190).
  const add = (section, severity, file, message, opts = {}) => {
    const key = JSON.stringify([section, severity, file, message]);
    if (seenFindings.has(key)) return;
    seenFindings.add(key);
    findings.push({
      section,
      severity,
      file,
      message,
      ...(changedSet.has(file) && !opts.noFromUpdate ? { fromUpdate: true } : {}),
    });
  };

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
    // A linked worktree (task worktree of the workspace repo, session
    // workspace) has its own git dir under the repo's common dir, so the two
    // rev-parse paths differ. Launcher-level state — cloned repos, the
    // launcher's branch — lives at the launcher, the parent of the common
    // dir; the worktree's own branch and dirty tree are expected mid-task,
    // not drift (gh:183).
    let launcherRoot = null;
    let launcherBranch = null;
    let launcherPorcelain = [];
    const gd = git(['rev-parse', '--git-dir']);
    const cd = git(['rev-parse', '--git-common-dir']);
    if (gd.status === 0 && cd.status === 0) {
      const resolveGitPath = (p) => {
        try { return realpathSync(resolve(absRoot, p.trim())); } catch { return null; }
      };
      const gitDir = resolveGitPath(gd.stdout);
      const commonDir = resolveGitPath(cd.stdout);
      if (gitDir && commonDir && gitDir !== commonDir) {
        launcherRoot = dirname(commonDir);
        const lb = spawnSync('git', ['-C', launcherRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
        launcherBranch = lb.status === 0 ? lb.stdout.trim() : null;
        const ls = spawnSync('git', ['-C', launcherRoot, 'status', '--porcelain'], { encoding: 'utf8' });
        if (ls.status === 0) {
          launcherPorcelain = ls.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        }
      }
    }
    return {
      isRepo: true,
      branch,
      defaultBranch,
      porcelain,
      branches: new Set(branches.status === 0 ? branches.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []),
      launcherRoot,
      launcherBranch,
      launcherPorcelain,
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
  // Cloned repos live at the launcher. From a task worktree the audit root's
  // own repos/ holds only nested worktrees, if anything — resolve the clone
  // check against the launcher (gh:183).
  const reposRoot = gitInfo.launcherRoot ?? absRoot;
  for (const name of Object.keys(reposManifest)) {
    if (!existsSync(join(reposRoot, 'repos', name))) {
      add('structure', 'warning', 'workspace.json', `repo '${name}' is in the manifest but repos/${name}/ is not cloned`);
    }
  }

  // Template-modification registry (gh:194), still under section 3 — it is
  // workspace structure: which files the workspace owns outright and which
  // template files it deliberately edits, and why. Legacy workspace.json
  // keys awaiting migration and registrations the workspace has abandoned
  // are info (both are /workspace-update offers, nothing is broken); a
  // registry that doesn't parse silently disables its exclusions and
  // reasons, which is worth a warning.
  {
    const mods = readTemplateModifications(absRoot);
    if (mods.parseError !== null) {
      add('structure', 'warning', '.claude/template-modifications.json',
        `does not parse (${mods.parseError}) — localFiles exclusions and modification reasons are being ignored; fix the JSON`);
    }
    if (mods.legacyKeys.length > 0) {
      add('structure', 'info', 'workspace.json',
        `legacy template-modification key(s) still present: ${mods.legacyKeys.map((k) => `workspace.${k}`).join(', ')} — /workspace-update offers to migrate them into .claude/template-modifications.json`);
    }
    const entries = Object.entries(mods.modifications);
    if (entries.length > 0) {
      const baseline = readBaseline(absRoot);
      if (baseline) {
        for (const [key, reason] of entries) {
          const rel = `.claude/${key}`;
          const baselineHash = baseline.files[rel];
          const installed = join(absRoot, rel);
          // Stale = the installed file is back to exactly what the template
          // last shipped (its baseline hash): the recorded edit is gone. A
          // missing file is NOT stale — a deliberate deletion is a live
          // decision the next update's deletedLocally ask will explain with
          // this very reason.
          if (typeof baselineHash !== 'string' || !existsSync(installed)) continue;
          if (hashBytes(readFileSync(installed)) === baselineHash) {
            add('structure', 'info', '.claude/template-modifications.json',
              `entry for ${rel} is stale — the file matches the template baseline again, the recorded edit is gone (reason: ${reason}); drop the entry`);
          }
        }
      }
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
    // Claude Code built-in commands can be mentioned alongside skills
    // without being workspace skills — never treat one as a list entry.
    const BUILTIN_COMMANDS = new Set([
      'goal', 'rename', 'clear', 'compact', 'help', 'config', 'permissions',
      'model', 'review', 'memory', 'init', 'doctor', 'hooks', 'mcp', 'agents',
      'resume', 'exit',
    ]);
    const listed = new Set();
    if (skillsSection !== null) {
      // Only a list entry counts as a skill reference: a line whose first
      // backticked token starts with `/name` (the token may carry argument
      // hints, as in `/start-work [handoff|blank]`). A `/name` mentioned
      // inside prose — the /goal-driven-work entry referencing the built-in
      // /goal — is not a skill claim and must not be flagged (gh:180 fix
      // round).
      for (const m of skillsSection.matchAll(/^\s*-\s+`\/([a-z0-9][a-z0-9-]*)[^`]*`/gm)) {
        if (!BUILTIN_COMMANDS.has(m[1])) listed.add(m[1]);
      }
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
        // Machine-local files never materialize inside a task worktree (the
        // update flow audits from one), so this is ambient, never something
        // the update caused (gh:190).
        add('cross-reference', 'info', 'CLAUDE.md', `@${posix} is absent — machine-local, expected on other machines`, { noFromUpdate: true });
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

    // Live-content scoping (gh:180 fix round): historical material is not
    // audited. Release archives reference branches that are gone by design
    // and predate frontmatter conventions, so auditing them buried a healthy
    // workspace under ~85 findings. Historical means: excluded from the
    // index by .indexignore (same interpretation as build-workspace-context
    // — prefix per line, trailing slash matches a directory), or inside any
    // directory named archive/. Session trackers are always live state and
    // never excluded.
    const ignorePrefixes = readIgnorePrefixes(join(absRoot, wcDir));
    const isHistorical = (rel) => {
      if (!rel.startsWith(`${wcDir}/`)) return false;
      const relToWC = rel.slice(wcDir.length + 1);
      if (isIgnored(relToWC, ignorePrefixes)) return true;
      return relToWC.split('/').includes('archive');
    };

    // Resolved lifecycles are closed out, not defects — however many there
    // are, they surface as ONE info line, not one per file (gh:190).
    const resolvedFiles = [];
    for (let i = 0; i < files.length; i++) {
      const rel = rels[i];
      if (ignored.has(rel) || isHistorical(rel)) continue;
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
      // Branch liveness is a property of live files: a resolved or otherwise
      // closed-out file legitimately references a branch deleted at
      // completion. Only active — or unlabeled — files flag it.
      const branchIsLive = !f.lifecycle || f.lifecycle === 'active';
      if (branchIsLive && typeof f.branch === 'string' && f.branch && gitInfo.isRepo && !gitInfo.branches.has(f.branch)) {
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
        resolvedFiles.push(rel);
      }
      if ('confidence' in f && !['high', 'medium', 'low'].includes(f.confidence)) {
        add('frontmatter', 'warning', rel, `confidence '${f.confidence}' is not one of high, medium, low`);
      }
    }
    if (resolvedFiles.length > 0) {
      const names = resolvedFiles.slice(0, 3).map((rel) => rel.split('/').pop());
      add('frontmatter', 'info', wcDir,
        `${resolvedFiles.length} lifecycle resolved file(s) — confirm /complete-work has processed them (${names.join(', ')}${resolvedFiles.length > 3 ? ', …' : ''})`);
    }
  })();

  // ---------- 4. git state ----------

  if (!gitInfo.isRepo) {
    add('git', 'info', '.', 'not a git repository — git checks skipped');
  } else {
    const dirty = gitInfo.porcelain.filter((l) => !l.startsWith('??'));
    const untracked = gitInfo.porcelain.filter((l) => l.startsWith('??'));
    if (gitInfo.launcherRoot) {
      // Auditing a worktree (task or session): its feature branch and dirty
      // tree are the in-flight work itself, so only the worktree's own checks
      // are skipped — the launcher-level questions are still asked, and
      // answered against the launcher.
      add('git', 'info', '.',
        `auditing from a worktree ('${gitInfo.branch}') — launcher checks resolved against ${toPosix(gitInfo.launcherRoot)}`);
      if (gitInfo.launcherBranch === 'HEAD') {
        add('git', 'warning', '.', 'launcher is in detached HEAD — it sits on its default branch');
      } else if (gitInfo.launcherBranch && gitInfo.launcherBranch !== gitInfo.defaultBranch) {
        add('git', 'warning', '.',
          `launcher is on branch '${gitInfo.launcherBranch}' — it stays on its default branch ('${gitInfo.defaultBranch}')`);
      }
      // --upgrade replaces the launcher's workspace-update skill before the
      // payload is applied, and the merged PR delivers the same content back:
      // a modification that equals the staged payload's copy is the expected
      // bootstrap, not drift — info, and out of the dirty warning (gh:190).
      const porcelainPath = (line) => line.slice(line.indexOf(' ') + 1).split(' -> ')[0];
      const launcherDirty = gitInfo.launcherPorcelain.filter((l) => !l.startsWith('??'));
      const bootstrap = launcherDirty.filter((l) => {
        const p = porcelainPath(l);
        if (!p.startsWith('.claude/skills/workspace-update/')) return false;
        try {
          return hashBytes(readFileSync(join(gitInfo.launcherRoot, p)))
            === hashBytes(readFileSync(join(gitInfo.launcherRoot, '.workspace-update', p)));
        } catch {
          return false; // no staged payload copy to compare against
        }
      });
      if (bootstrap.length > 0) {
        add('git', 'info', '.',
          "launcher's .claude/skills/workspace-update/ replaced by --upgrade (matches the staged payload) — expected until the update merges");
      }
      const drift = launcherDirty.filter((l) => !bootstrap.includes(l));
      if (drift.length > 0) {
        const paths = drift.slice(0, 5).map((l) => l.slice(l.indexOf(' ') + 1).replace(/ -> /, ' → '));
        add('git', 'warning', '.',
          `launcher has ${drift.length} tracked file(s) with uncommitted changes: ${paths.join(', ')}${drift.length > 5 ? ', …' : ''}`);
      }
      add('git', 'info', '.',
        'uncommitted-changes check skipped — the worktree is expected to carry in-flight changes');
    } else {
      if (gitInfo.branch === 'HEAD') {
        add('git', 'warning', '.', 'detached HEAD — the launcher sits on its default branch');
      } else if (gitInfo.branch !== gitInfo.defaultBranch) {
        add('git', 'warning', '.',
          `on branch '${gitInfo.branch}' — the launcher stays on its default branch ('${gitInfo.defaultBranch}')`);
      }
      if (dirty.length > 0) {
        // Porcelain is "XY <path>" (the leading X is a space for unstaged
        // changes, and the line was trimmed), so the path starts after the
        // first space.
        const paths = dirty.slice(0, 5).map((l) => l.slice(l.indexOf(' ') + 1).replace(/ -> /, ' → '));
        add('git', 'warning', '.',
          `${dirty.length} tracked file(s) with uncommitted changes: ${paths.join(', ')}${dirty.length > 5 ? ', …' : ''}`);
      }
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
  // A section with more than this many findings of one severity prints one
  // summary line instead of the list — a report meant to be read caps its
  // own length; --json carries the full list (gh:180 fix round).
  const COLLAPSE_AT = 5;
  const lines = [`Workspace audit — ${summary.root}`, ''];
  for (const sec of SECTIONS) {
    lines.push(`${sec.n}. ${sec.label}`);
    const found = issues.filter((f) => f.section === sec.key);
    if (found.length > 0) {
      for (const severity of ['issue', 'warning', 'info']) {
        const group = found.filter((f) => f.severity === severity);
        if (group.length === 0) continue;
        if (group.length > COLLAPSE_AT) {
          const first3 = group.slice(0, 3).map((f) => f.file).join(', ');
          lines.push(
            `   ${marks[severity]} ${group.length} ${severity}(s) — ${first3}, +${group.length - 3} more (run with --json for the full list)`,
          );
        } else {
          for (const f of group) {
            lines.push(`   ${marks[severity]} ${f.file}: ${f.message}${f.fromUpdate ? ' (from this update)' : ''}`);
          }
        }
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
