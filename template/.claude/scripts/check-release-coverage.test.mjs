#!/usr/bin/env node
// Unit tests for check-release-coverage.mjs
// Run: node .claude/scripts/check-release-coverage.test.mjs
//
// All fixtures live under mkdtempSync(os.tmpdir()) and are removed after
// each test. Both `forge` and `isBranchMerged` are always injected —
// these tests never hit the network or real git state.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkReleaseCoverage,
  parseArgs,
  parseFrontmatter,
  lastReleaseDate,
  repoSlugFromRemote,
  collectCoveredBranches,
  lastReleaseVersion,
  lastReleaseCutoff,
  dayBefore,
} from './check-release-coverage.mjs';

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'check-release-coverage-test-'));
}

function writeWorkspaceJson(root, { repos, releaseNotesDir, forge } = {}) {
  const ws = {
    workspace: {
      name: 'fixture',
      ...(releaseNotesDir ? { releaseNotesDir } : {}),
      ...(forge !== undefined ? { forge } : {}),
    },
    repos: repos || {
      'create-ulysses-workspace': {
        remote: 'https://github.com/ukt-solutions/create-ulysses-workspace.git',
        branch: 'main',
      },
    },
  };
  writeFileSync(join(root, 'workspace.json'), JSON.stringify(ws, null, 2));
}

function writeChangelog(root, repo, content) {
  mkdirSync(join(root, 'repos', repo), { recursive: true });
  writeFileSync(join(root, 'repos', repo, 'CHANGELOG.md'), content);
}

function writeBranchNotes(root, releaseNotesDir, repo, filename, branch) {
  const dir = join(root, releaseNotesDir, 'unreleased', repo);
  mkdirSync(dir, { recursive: true });
  const fm = branch === undefined
    ? '---\ntopic: no-branch-field\n---\n\nSome notes.\n'
    : `---\nbranch: ${branch}\ntopic: whatever\n---\n\nSome notes.\n`;
  writeFileSync(join(dir, filename), fm);
}

function writeSession(root, sessionName, { branch, repos, status = 'active' } = {}) {
  const dir = join(root, 'work-sessions', sessionName, 'workspace');
  mkdirSync(dir, { recursive: true });
  const reposBlock = (repos || []).map((r) => `  - ${r}`).join('\n');
  const content = `---\ntype: session-tracker\nname: ${sessionName}\nstatus: ${status}\nbranch: ${branch}\nrepos:\n${reposBlock}\n---\n\n# Work Session: ${sessionName}\n`;
  writeFileSync(join(dir, 'session.md'), content);
}

function fakeForge(prs) {
  return {
    async prList() { return prs; },
  };
}

function noBranchesMerged() { return () => false; }
function allBranchesMerged() { return () => true; }

const RELEASE_NOTES_DIR = 'workspace-context/release-notes';

// ---------- 1. repoSlugFromRemote ----------

{
  assertEq(repoSlugFromRemote('https://github.com/ukt-solutions/create-ulysses-workspace.git'), 'ukt-solutions/create-ulysses-workspace', 'https with .git');
  assertEq(repoSlugFromRemote('https://github.com/ukt-solutions/create-ulysses-workspace'), 'ukt-solutions/create-ulysses-workspace', 'https without .git');
  assertEq(repoSlugFromRemote('git@github.com:ukt-solutions/create-ulysses-workspace.git'), 'ukt-solutions/create-ulysses-workspace', 'git@ with .git');
  assertEq(repoSlugFromRemote('git@github.com:ukt-solutions/create-ulysses-workspace'), 'ukt-solutions/create-ulysses-workspace', 'git@ without .git');
}

// ---------- 2. lastReleaseDate ----------

{
  const root = makeRoot();
  writeChangelog(root, 'proj', '# Changelog\n\n## v1.2.3 — 2026-08-01\n\nStuff.\n');
  assertEq(lastReleaseDate(root, 'proj'), '2026-08-01', 'em-dash heading parses');
  rmSync(root, { recursive: true, force: true });
}
{
  const root = makeRoot();
  writeChangelog(root, 'proj', '# Changelog\n\n## v1.2.3 - 2026-08-01\n\nStuff.\n');
  assertEq(lastReleaseDate(root, 'proj'), '2026-08-01', 'hyphen heading parses');
  rmSync(root, { recursive: true, force: true });
}
{
  const root = makeRoot();
  assertEq(lastReleaseDate(root, 'proj'), null, 'missing CHANGELOG.md returns null');
  rmSync(root, { recursive: true, force: true });
}
{
  const root = makeRoot();
  writeChangelog(root, 'proj', '# Changelog\n\nNothing versioned here yet.\n');
  assertEq(lastReleaseDate(root, 'proj'), null, 'CHANGELOG with no version heading returns null');
  rmSync(root, { recursive: true, force: true });
}
{
  const root = makeRoot();
  writeChangelog(root, 'proj', '# Changelog\n\n## v2.0.0 — 2026-09-01\n\n## v1.9.0 — 2026-08-01\n\n## v1.8.0 — 2026-07-01\n');
  assertEq(lastReleaseDate(root, 'proj'), '2026-09-01', 'first heading wins when several are present');
  rmSync(root, { recursive: true, force: true });
}

// ---------- 3. collectCoveredBranches ----------

{
  const root = makeRoot();
  writeBranchNotes(root, RELEASE_NOTES_DIR, 'proj', 'branch-release-notes-foo.md', 'feature/foo');
  writeBranchNotes(root, RELEASE_NOTES_DIR, 'proj', 'branch-release-notes-bar.md', 'bugfix/bar');
  writeFileSync(join(root, RELEASE_NOTES_DIR, 'unreleased', 'proj', 'not-a-notes-file.md'), '---\nbranch: chore/ignored\n---\n');
  const covered = collectCoveredBranches(root, RELEASE_NOTES_DIR, 'proj');
  assertEq(Array.from(covered).sort(), ['bugfix/bar', 'feature/foo'], 'reads branch: from several notes files');
  rmSync(root, { recursive: true, force: true });
}
{
  const root = makeRoot();
  writeBranchNotes(root, RELEASE_NOTES_DIR, 'proj', 'branch-release-notes-no-fm.md', undefined);
  const covered = collectCoveredBranches(root, RELEASE_NOTES_DIR, 'proj');
  assertEq(Array.from(covered), [], 'tolerates a notes file with no branch field');
  rmSync(root, { recursive: true, force: true });
}
{
  const root = makeRoot();
  const covered = collectCoveredBranches(root, RELEASE_NOTES_DIR, 'proj');
  assertEq(Array.from(covered), [], 'missing unreleased dir returns empty set');
  rmSync(root, { recursive: true, force: true });
}

// ---------- 4-7, 11: checkReleaseCoverage core logic ----------

async function run4() {
  const root = makeRoot();
  writeWorkspaceJson(root);
  writeBranchNotes(root, RELEASE_NOTES_DIR, 'create-ulysses-workspace', 'branch-release-notes-foo.md', 'feature/foo');
  const forge = fakeForge([
    { number: 1, title: 'Add foo', url: 'https://github.com/o/n/pull/1', headRefName: 'feature/foo', baseRefName: 'main', mergedAt: '2026-09-01', state: 'MERGED' },
  ]);
  const result = await checkReleaseCoverage({ root, repo: 'create-ulysses-workspace', forge, isBranchMerged: noBranchesMerged() });
  assertEq(result.uncoveredPrs, [], 'merged PR with matching notes file is not uncovered');
  assert(result.shouldRefuse === false, 'covered PR alone does not force refusal');
  rmSync(root, { recursive: true, force: true });
}

async function run5() {
  const root = makeRoot();
  writeWorkspaceJson(root);
  const forge = fakeForge([
    { number: 2, title: 'Add bar', url: 'https://github.com/o/n/pull/2', headRefName: 'feature/bar', baseRefName: 'main', mergedAt: '2026-09-01', state: 'MERGED' },
  ]);
  const result = await checkReleaseCoverage({ root, repo: 'create-ulysses-workspace', forge, isBranchMerged: noBranchesMerged() });
  assertEq(result.uncoveredPrs.length, 1, 'merged PR with no notes file is uncovered');
  assertEq(result.uncoveredPrs[0].number, 2, 'uncovered PR carries the right number');
  assert(result.shouldRefuse === true, 'uncovered PR forces refusal');
  rmSync(root, { recursive: true, force: true });
}

async function run6() {
  const root = makeRoot();
  writeWorkspaceJson(root);
  const forge = fakeForge([
    { number: 3, title: 'Release v1.2.3', url: 'https://github.com/o/n/pull/3', headRefName: 'release/v1.2.3', baseRefName: 'main', mergedAt: '2026-09-01', state: 'MERGED' },
  ]);
  const result = await checkReleaseCoverage({ root, repo: 'create-ulysses-workspace', forge, isBranchMerged: noBranchesMerged() });
  assertEq(result.uncoveredPrs, [], 'release/* branch is excluded from uncovered PRs');
  assert(result.shouldRefuse === false, 'release PR alone does not force refusal');
  rmSync(root, { recursive: true, force: true });
}

async function run7() {
  const root = makeRoot();
  writeWorkspaceJson(root);
  const forge = fakeForge([]);
  const result = await checkReleaseCoverage({ root, repo: 'create-ulysses-workspace', forge, isBranchMerged: noBranchesMerged() });
  assertEq(result.uncoveredPrs, [], 'trivial case: no PRs');
  assertEq(result.staleSessions, [], 'trivial case: no sessions');
  assert(result.shouldRefuse === false, 'trivial case does not refuse even though notes dir is empty');
  rmSync(root, { recursive: true, force: true });
}

async function run11() {
  const root = makeRoot();
  writeWorkspaceJson(root);
  const forge = fakeForge([
    { number: 9, title: 'Add baz', url: 'https://github.com/o/n/pull/9', headRefName: 'feature/baz', baseRefName: 'main', mergedAt: '2026-09-01', state: 'MERGED' },
  ]);
  const result = await checkReleaseCoverage({ root, repo: 'create-ulysses-workspace', force: true, forge, isBranchMerged: noBranchesMerged() });
  assertEq(result.forced, true, '--force sets forced: true');
  assertEq(result.shouldRefuse, true, '--force does not change shouldRefuse in the payload');
  rmSync(root, { recursive: true, force: true });
}

// ---------- 8-10: stale sessions ----------

async function run8() {
  const root = makeRoot();
  writeWorkspaceJson(root);
  writeSession(root, 'merged-uncovered', { branch: 'feature/gone', repos: ['create-ulysses-workspace'] });
  const forge = fakeForge([]);
  const result = await checkReleaseCoverage({ root, repo: 'create-ulysses-workspace', forge, isBranchMerged: allBranchesMerged() });
  assertEq(result.staleSessions.length, 1, 'merged + uncovered session is reported');
  assertEq(result.staleSessions[0], { sessionName: 'merged-uncovered', worktreePath: join('work-sessions', 'merged-uncovered', 'workspace'), branch: 'feature/gone' }, 'stale session carries name/worktree/branch');
  assert(result.shouldRefuse === true, 'stale session forces refusal');
  rmSync(root, { recursive: true, force: true });
}

async function run9() {
  const root = makeRoot();
  writeWorkspaceJson(root);
  writeSession(root, 'still-open', { branch: 'feature/still-open', repos: ['create-ulysses-workspace'] });
  const forge = fakeForge([]);
  const result = await checkReleaseCoverage({ root, repo: 'create-ulysses-workspace', forge, isBranchMerged: noBranchesMerged() });
  assertEq(result.staleSessions, [], 'session whose branch is not merged is not reported');
  assert(result.shouldRefuse === false, 'unmerged session does not force refusal');
  rmSync(root, { recursive: true, force: true });
}

async function run10() {
  const root = makeRoot();
  writeWorkspaceJson(root, {
    repos: {
      'create-ulysses-workspace': { remote: 'https://github.com/ukt-solutions/create-ulysses-workspace.git', branch: 'main' },
      'ulysses-app': { remote: 'https://github.com/ukt-solutions/ulysses-app.git', branch: 'main' },
    },
  });
  writeSession(root, 'other-repo-session', { branch: 'feature/other', repos: ['ulysses-app'] });
  const forge = fakeForge([]);
  const result = await checkReleaseCoverage({ root, repo: 'create-ulysses-workspace', forge, isBranchMerged: allBranchesMerged() });
  assertEq(result.staleSessions, [], 'session for a different repo is not reported');
  rmSync(root, { recursive: true, force: true });
}

// ---------- 12. parseArgs ----------

{
  let threw = false;
  try { parseArgs(['node', 'script.mjs']); } catch { threw = true; }
  assert(threw, 'parseArgs requires --repo');
}
{
  let threw = false;
  try { parseArgs(['node', 'script.mjs', '--repo', 'x', '--bogus']); } catch { threw = true; }
  assert(threw, 'parseArgs rejects unknown flags');
}
{
  const args = parseArgs(['node', 'script.mjs', '--root', '/tmp/foo', '--repo', 'x', '--json', '--force']);
  assertEq(args, { root: '/tmp/foo', repo: 'x', json: true, force: true }, 'parseArgs parses all flags');
}

// ---------- parseFrontmatter (supporting unit) ----------

{
  const fm = parseFrontmatter('---\nbranch: feature/x\nstatus: active\nrepos:\n  - a\n  - b\n---\n\nbody\n');
  assertEq(fm.branch, 'feature/x', 'parseFrontmatter reads scalar');
  assertEq(fm.repos, ['a', 'b'], 'parseFrontmatter reads block list');
}
{
  const fm = parseFrontmatter('no frontmatter here\n');
  assertEq(fm, {}, 'parseFrontmatter tolerates content with no frontmatter fence');
}

// ---------- 13. cwd independence ----------

async function run13() {
  const fixtureRoot = makeRoot();
  writeWorkspaceJson(fixtureRoot);
  const forge = fakeForge([
    { number: 5, title: 'Add qux', url: 'https://github.com/o/n/pull/5', headRefName: 'feature/qux', baseRefName: 'main', mergedAt: '2026-09-01', state: 'MERGED' },
  ]);

  const elsewhere = mkdtempSync(join(tmpdir(), 'check-release-coverage-elsewhere-'));
  const originalCwd = process.cwd();
  process.chdir(elsewhere);
  let result;
  try {
    result = await checkReleaseCoverage({ root: fixtureRoot, repo: 'create-ulysses-workspace', forge, isBranchMerged: noBranchesMerged() });
  } finally {
    process.chdir(originalCwd);
  }

  assertEq(result.uncoveredPrs.length, 1, 'cwd-independent: still finds the uncovered PR from the fixture root');
  assertEq(result.repo, 'create-ulysses-workspace', 'cwd-independent: result is scoped to the fixture root, not cwd');

  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
}


// ---------- 14. release boundary is an instant, not a calendar date ----------
//
// Regression for the bug this guard reported on its very first real run. The
// CHANGELOG heading carries a LOCAL calendar date while merge timestamps are
// UTC, so a PR merged 20:38 local on release day is 00:38Z the next day, and a
// naive `merged:>DATE` window swallows it — despite it having shipped in that
// very release, eleven minutes before the release PR. Fixtures below use the
// real numbers from that run.

function gitFnReturning(iso) {
  return () => ({ status: 0, stdout: `${iso}\n`, stderr: '' });
}
const gitFnNoTag = () => ({ status: 1, stdout: '', stderr: 'unknown revision' });

{
  assertEq(dayBefore('2026-06-10'), '2026-06-09', 'dayBefore simple');
  assertEq(dayBefore('2026-06-01'), '2026-05-31', 'dayBefore across month');
  assertEq(dayBefore('2026-01-01'), '2025-12-31', 'dayBefore across year');
  assertEq(dayBefore('2026-03-01'), '2026-02-28', 'dayBefore across non-leap february');
}

{
  const root = makeRoot();
  try {
    writeChangelog(root, 'create-ulysses-workspace', '## v0.17.0-beta.0 — 2026-06-10\n\nstuff\n');
    assertEq(lastReleaseVersion(root, 'create-ulysses-workspace'), '0.17.0-beta.0', 'version parsed from heading');
    assertEq(lastReleaseDate(root, 'create-ulysses-workspace'), '2026-06-10', 'date still parsed after regex change');

    assertEq(
      lastReleaseCutoff(root, 'create-ulysses-workspace', [], { gitFn: gitFnReturning('2026-06-10T20:49:58-04:00') }),
      '2026-06-11T00:49:58.000Z',
      'cutoff prefers the git tag instant',
    );

    const prs = [
      { number: 77, headRefName: 'release/v0.17.0-beta.0', mergedAt: '2026-06-11T00:49:58Z' },
      { number: 60, headRefName: 'release/v0.16.0-beta.1', mergedAt: '2026-05-17T10:00:00Z' },
    ];
    assertEq(
      lastReleaseCutoff(root, 'create-ulysses-workspace', prs, { gitFn: gitFnNoTag }),
      '2026-06-11T00:49:58.000Z',
      'cutoff falls back to the newest release PR',
    );

    assertEq(
      lastReleaseCutoff(root, 'create-ulysses-workspace', [], { gitFn: gitFnNoTag }),
      '2026-06-10T23:59:59.999Z',
      'cutoff falls back to end of the changelog day, not its midnight',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function run14() {
  const root = makeRoot();
  try {
    writeWorkspaceJson(root);
    writeChangelog(root, 'create-ulysses-workspace', '## v0.17.0-beta.0 — 2026-06-10\n');
    const forge = fakeForge([
      { number: 76, title: 'fix: remove WorktreeCreate advisory hook', headRefName: 'bugfix/worktree-create-hook',
        url: 'https://x/76', mergedAt: '2026-06-11T00:38:52Z', state: 'MERGED' },
      { number: 77, title: 'release: v0.17.0-beta.0', headRefName: 'release/v0.17.0-beta.0',
        url: 'https://x/77', mergedAt: '2026-06-11T00:49:58Z', state: 'MERGED' },
    ]);
    const res = await checkReleaseCoverage({
      root, repo: 'create-ulysses-workspace', forge,
      isBranchMerged: allBranchesMerged(),
      gitFn: gitFnReturning('2026-06-10T20:49:58-04:00'),
    });
    assertEq(res.uncoveredPrs, [], 'a PR merged before the release instant is NOT uncovered');
    assert(res.shouldRefuse === false, 'same-release PR must not force a refusal');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function run15() {
  const root = makeRoot();
  try {
    writeWorkspaceJson(root);
    writeChangelog(root, 'create-ulysses-workspace', '## v0.17.0-beta.0 — 2026-06-10\n');
    const forge = fakeForge([
      { number: 90, title: 'feat: something later', headRefName: 'feature/later',
        url: 'https://x/90', mergedAt: '2026-07-01T12:00:00Z', state: 'MERGED' },
    ]);
    const res = await checkReleaseCoverage({
      root, repo: 'create-ulysses-workspace', forge,
      isBranchMerged: noBranchesMerged(),
      gitFn: gitFnReturning('2026-06-10T20:49:58-04:00'),
    });
    assertEq(res.uncoveredPrs.map((p) => p.number), [90], 'a PR merged after the release IS uncovered');
    assert(res.shouldRefuse === true, 'genuinely-unreleased PR still refuses');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function main() {
  await run4();
  await run5();
  await run6();
  await run7();
  await run8();
  await run9();
  await run10();
  await run11();
  await run13();
  await run14();
  await run15();

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
