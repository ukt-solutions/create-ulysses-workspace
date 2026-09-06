#!/usr/bin/env node
// Guard /release against a merged-but-uncovered branch, not just an empty
// release-notes directory (gh:89).
//
// /release lists `{releaseNotesDir}/unreleased/{repo}/` and, finding it
// empty, reports "Nothing to release." That's correct when nothing shipped
// since the last release, and badly wrong when `/complete-work` was
// skipped on a merged session — its detail then never reaches the
// changelog, and the next release silently inherits the gap. This script
// tells the two cases apart by cross-referencing the branches already
// covered by a `branch-release-notes-*.md` file against the branches of
// merged pull requests (via the forge adapter) and of local work sessions
// whose branch already looks merged but were never torn down.
//
// The trivial case — no uncovered PRs, no stale sessions — is NOT a
// refusal, even when the notes directory is completely empty.
//
// Usage:
//   node check-release-coverage.mjs --root <dir> --repo <name>
//   node check-release-coverage.mjs --root <dir> --repo <name> --json
//   node check-release-coverage.mjs --root <dir> --repo <name> --force
//
// --root defaults to `.`. --repo is required: the project-repo key as it
// appears in `workspace.json` -> `repos`.
//
// Exit codes:
//   0 — release may proceed (including under --force, which still reports
//       but does not refuse)
//   1 — release should be refused: at least one uncovered merged PR or one
//       stale (merged-but-not-completed) session was found
//   2 — unexpected error (stderr prefixed `check-release-coverage:`)

import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createForge } from './forges/interface.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const DEFAULT_RELEASE_NOTES_DIR = 'workspace-context/release-notes';
const BRANCH_NOTES_RE = /^branch-release-notes-.*\.md$/;
const RELEASE_HEADING_RE = /^##\s+v(\S+)\s+(?:—|-)\s+(\d{4}-\d{2}-\d{2})/m;

function parseArgs(argv) {
  const args = { root: '.', repo: null, json: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--force') args.force = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (!args.repo) throw new Error('--repo is required');
  return args;
}

// Adapter-agnostic GitHub remote parsing: handles both
// `https://github.com/o/n.git` and `git@github.com:o/n.git`, with or
// without the trailing `.git`.
function repoSlugFromRemote(remote) {
  if (!remote) throw new Error('repoSlugFromRemote: remote is required');
  let m = remote.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = remote.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  throw new Error(`Cannot parse repo slug from remote: ${remote}`);
}

// Minimal line-based frontmatter reader. Deliberately not a YAML parser —
// this only needs to read a handful of flat scalars and one flat list
// (`repos:`) out of branch-release-notes files and session.md trackers.
function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return {};

  const fields = {};
  const fmLines = lines.slice(1, end);
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = m[2].trim();

    if (rest === '') {
      // Possible block list (`repos:\n  - foo\n  - bar`); otherwise an
      // empty scalar.
      const items = [];
      let j = i + 1;
      while (j < fmLines.length && /^\s*-\s+/.test(fmLines[j])) {
        items.push(stripQuotes(fmLines[j].replace(/^\s*-\s+/, '').trim()));
        j++;
      }
      if (items.length > 0) {
        fields[key] = items;
        i = j;
      } else {
        fields[key] = '';
        i++;
      }
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      fields[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
      i++;
      continue;
    }

    fields[key] = stripQuotes(rest);
    i++;
  }
  return fields;
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// First `## v<version> — <YYYY-MM-DD>` heading in the repo's CHANGELOG.md
// (em dash or plain hyphen as separator). `null` means "no prior release".
function lastReleaseDate(root, repo) {
  const changelogPath = join(root, 'repos', repo, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) return null;
  const content = readFileSync(changelogPath, 'utf-8');
  const m = content.match(RELEASE_HEADING_RE);
  return m ? m[2] : null;
}

// One calendar day earlier, as YYYY-MM-DD. Used only to widen the coarse
// server-side query; the real boundary is `lastReleaseCutoff`.
function dayBefore(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Version string from the same heading, so the cutoff resolver can look up
// the matching git tag.
function lastReleaseVersion(root, repo) {
  const changelogPath = join(root, 'repos', repo, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) return null;
  const m = readFileSync(changelogPath, 'utf-8').match(RELEASE_HEADING_RE);
  return m ? m[1] : null;
}

// The boundary between "already released" and "unreleased" is an *instant*,
// not a calendar date.
//
// The CHANGELOG heading carries a local calendar date, but merge timestamps
// are UTC. A PR merged at 20:38 local on release day is 00:38Z the next day,
// so a `merged:>2026-06-10` window swallows it even though it shipped in that
// very release eleven minutes before the release PR itself. That is not
// hypothetical — it is exactly what this guard reported the first time it was
// pointed at a real workspace (gh:89).
//
// So resolve the tightest boundary available, in order:
//   1. the git tag for the released version — an exact instant
//   2. the release PR that shipped it — also exact
//   3. end of the changelog's calendar day in UTC — a wide fallback that at
//      least stops swallowing same-day merges
// `null` means no prior release, so nothing is out of window.
function lastReleaseCutoff(root, repo, prs = [], { gitFn = nodeSpawnSync } = {}) {
  const version = lastReleaseVersion(root, repo);
  if (!version) return null;

  const tagged = gitFn(
    'git',
    ['-C', join(root, 'repos', repo), 'log', '-1', '--format=%aI', `v${version}`],
    { encoding: 'utf-8' },
  );
  if (tagged.status === 0 && (tagged.stdout || '').trim()) {
    return new Date(tagged.stdout.trim()).toISOString();
  }

  const releasePr = prs
    .filter((pr) => (pr.headRefName || '').startsWith('release/') && pr.mergedAt)
    .sort((a, b) => new Date(b.mergedAt) - new Date(a.mergedAt))[0];
  if (releasePr) return new Date(releasePr.mergedAt).toISOString();

  const date = lastReleaseDate(root, repo);
  return date ? `${date}T23:59:59.999Z` : null;
}

// Branches already covered by a hand-written or /complete-work-produced
// branch-release-notes file for this repo.
function collectCoveredBranches(root, releaseNotesDir, repo) {
  const covered = new Set();
  const dir = join(root, releaseNotesDir, 'unreleased', repo);
  if (!existsSync(dir)) return covered;
  for (const name of readdirSync(dir)) {
    if (!BRANCH_NOTES_RE.test(name)) continue;
    const content = readFileSync(join(dir, name), 'utf-8');
    const fm = parseFrontmatter(content);
    if (typeof fm.branch === 'string' && fm.branch) covered.add(fm.branch);
  }
  return covered;
}

// Default merged-ness predicate: a branch with no local ref is treated as
// merged-and-cleaned-up; a branch that still exists locally is merged when
// its tip is reachable from `main`. Real git, real filesystem — tests
// always inject their own `isBranchMerged` instead of exercising this.
function defaultIsBranchMerged(root, branch) {
  const list = nodeSpawnSync('git', ['-C', root, 'branch', '--list', branch], { encoding: 'utf-8' });
  const existsLocally = list.status === 0 && list.stdout.trim() !== '';
  if (!existsLocally) return true;
  const contains = nodeSpawnSync('git', ['-C', root, 'log', 'main', '--oneline', '--contains', branch], { encoding: 'utf-8' });
  return contains.status === 0 && contains.stdout.trim() !== '';
}

async function checkReleaseCoverage({ root = '.', repo, force = false, forge, isBranchMerged, gitFn } = {}) {
  if (!repo) throw new Error('checkReleaseCoverage: repo is required');
  const resolvedRoot = resolve(root);

  const wsPath = join(resolvedRoot, 'workspace.json');
  const ws = JSON.parse(readFileSync(wsPath, 'utf-8'));
  const repoConfig = ws.repos && ws.repos[repo];
  if (!repoConfig) {
    throw new Error(`Repo "${repo}" is not in workspace.json -> repos`);
  }

  const slug = repoSlugFromRemote(repoConfig.remote);
  const releaseNotesDir = ws.workspace?.releaseNotesDir || DEFAULT_RELEASE_NOTES_DIR;

  const coveredBranches = collectCoveredBranches(resolvedRoot, releaseNotesDir, repo);
  const releaseDate = lastReleaseDate(resolvedRoot, repo);

  const forgeAdapter = forge || createForge(ws.workspace?.forge);
  // Widen the server-side window by a day: `merged:>DATE` is UTC-midnight
  // granular, and the precise boundary is applied below against real
  // timestamps. Fetching a little extra is free; missing a PR is not.
  const prs = await forgeAdapter.prList({
    state: 'merged',
    base: 'main',
    repo: slug,
    search: releaseDate ? `merged:>${dayBefore(releaseDate)}` : undefined,
  });

  const cutoff = lastReleaseCutoff(resolvedRoot, repo, prs, { gitFn });

  const uncoveredPrs = prs
    .filter((pr) => !cutoff || !pr.mergedAt || new Date(pr.mergedAt) > new Date(cutoff))
    .filter((pr) => !(pr.headRefName || '').startsWith('release/'))
    .filter((pr) => !coveredBranches.has(pr.headRefName))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
      url: pr.url,
      mergedAt: pr.mergedAt,
    }));

  const mergedCheck = isBranchMerged || ((branch) => defaultIsBranchMerged(resolvedRoot, branch));

  const staleSessions = [];
  const sessionsDir = join(resolvedRoot, 'work-sessions');
  if (existsSync(sessionsDir)) {
    for (const sessionName of readdirSync(sessionsDir)) {
      const sessionMdPath = join(sessionsDir, sessionName, 'workspace', 'session.md');
      if (!existsSync(sessionMdPath)) continue;
      const fm = parseFrontmatter(readFileSync(sessionMdPath, 'utf-8'));
      const sessionRepos = Array.isArray(fm.repos) ? fm.repos : (fm.repos ? [fm.repos] : []);
      if (!sessionRepos.includes(repo)) continue;
      const branch = fm.branch;
      if (!branch || coveredBranches.has(branch)) continue;
      if (mergedCheck(branch)) {
        staleSessions.push({
          sessionName,
          worktreePath: join('work-sessions', sessionName, 'workspace'),
          branch,
        });
      }
    }
  }

  const shouldRefuse = uncoveredPrs.length > 0 || staleSessions.length > 0;

  return {
    repo,
    slug,
    lastReleaseDate: releaseDate,
    releaseCutoff: cutoff,
    coveredBranches: Array.from(coveredBranches),
    uncoveredPrs,
    staleSessions,
    shouldRefuse,
    forced: force,
  };
}

function formatHuman(result) {
  const lines = [`check-release-coverage: ${result.repo} (${result.slug})`];
  if (!result.shouldRefuse) {
    lines.push('OK — no uncovered merged PRs, no stale sessions. Release may proceed.');
    return lines.join('\n');
  }

  lines.push('REFUSING — unreleased detail would be lost:');

  if (result.uncoveredPrs.length > 0) {
    lines.push('');
    lines.push('Merged PRs with no branch-release-notes file:');
    for (const pr of result.uncoveredPrs) {
      lines.push(`  #${pr.number} "${pr.title}" (${pr.headRefName}) — ${pr.url}`);
    }
  }

  if (result.staleSessions.length > 0) {
    lines.push('');
    lines.push('Sessions whose branch is merged but the session was never completed:');
    for (const s of result.staleSessions) {
      lines.push(`  ${s.worktreePath} (${s.branch})`);
    }
  }

  lines.push('');
  lines.push('Remediation: run /complete-work from each listed worktree. For PRs with no');
  lines.push('local worktree, hand-write a branch-release-notes-{topic}.md into');
  lines.push('<releaseNotesDir>/unreleased/<repo>/.');

  if (result.forced) {
    lines.push('');
    lines.push('--force set: proceeding anyway (exit 0).');
  } else {
    lines.push('');
    lines.push('Re-run with --force to proceed anyway.');
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await checkReleaseCoverage({ root: args.root, repo: args.repo, force: args.force });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result)}\n`);
  }

  process.exit(result.shouldRefuse && !args.force ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`check-release-coverage: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}

export {
  checkReleaseCoverage,
  parseArgs,
  parseFrontmatter,
  lastReleaseDate,
  lastReleaseVersion,
  lastReleaseCutoff,
  dayBefore,
  repoSlugFromRemote,
  collectCoveredBranches,
};
