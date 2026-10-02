#!/usr/bin/env node
// Unit tests for upgrade.mjs
// Run: node lib/upgrade.test.mjs
//
// Covers the tracked-payload warning (.workspace-update/ is gitignored
// from v0.19.0, but a workspace upgraded from an older template may still
// carry a tracked payload), the workspace-update skill bootstrap (--upgrade
// installs the payload's copy so the workspace never runs an outdated
// flow), baseline reconstruction for pre-baseline workspaces (gh:186), and
// the .template-base/ merge-base staging every upgrade attempts (gh:193)
// — the tarball fetch is injected so the suite never touches the network.
import { upgradeWorkspace } from './upgrade.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';

let failed = 0;
let passed = 0;
function check(label, ok) {
  if (ok) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

async function captureConsole(fn) {
  const out = { log: [], error: [] };
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => { out.log.push(a.join(' ')); };
  console.error = (...a) => { out.error.push(a.join(' ')); };
  try {
    return { result: await fn(), out };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

function buildWorkspace({ templateVersion = '0.15.0', baseline = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-test-'));
  execSync('git init -q -b main', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email test@example.com', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name Test', { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({
    workspace: { name: 'demo', initialized: true, templateVersion },
    repos: {},
  }, null, 2) + '\n');
  if (baseline) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.template-baseline.json'), JSON.stringify({
      templateVersion,
      files: { '.claude/hooks/a.mjs': '0'.repeat(64) },
    }) + '\n');
  }
  execSync('git add workspace.json', { cwd: root, stdio: 'pipe' });
  execSync('git commit -q -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

function lsFilesPayload(root) {
  return spawnSync('git', ['ls-files', '.workspace-update'], {
    cwd: root,
    encoding: 'utf-8',
  }).stdout.split('\n').filter(Boolean);
}

// ---- fixture tarballs (old live-name layout and new inert layout) ----

function tarEntry(name, content, type = '0') {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

function makeTarball(entries) {
  return gzipSync(Buffer.concat([
    ...entries.map(([name, content, type]) => tarEntry(name, content, type)),
    Buffer.alloc(1024),
  ]));
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
// The fixtures are ASCII with LF endings, so a plain sha256 of the text
// equals template-baseline's CRLF-normalized hashBytes.
const hashFile = (p) => sha(readFileSync(p, 'utf8'));

// A v0.18-era package: every path rooted under package/ (npm's layout),
// template/ still carried the live names.
const OLD_LAYOUT_TARBALL = makeTarball([
  ['package/package.json', '{"name":"@ulysses-ai/create-workspace"}\n'],
  ['package/template/CLAUDE.md.tmpl', '## Workspace: {{project-name}}\n'],
  ['package/template/.claude/hooks/session-start.mjs', '// hooks v0.15\n'],
  ['package/template/.claude/scripts/old.mjs', '// script\n'],
  ['package/template/.mcp.json', '{"mcpServers":{}}\n'],
  ['package/template/.claudeignore', 'scratch/\n'],
]);

// A v0.19-on package: template/ stores the inert names.
const NEW_LAYOUT_TARBALL = makeTarball([
  ['package/template/_claude/hooks/session-start.mjs', '// hooks v0.19\n'],
  ['package/template/_claude/scripts/new.mjs', '// script\n'],
  ['package/template/_mcp.json', '{"mcpServers":{}}\n'],
  ['package/template/.claudeignore', 'scratch/\n'],
]);

// Injected fetch results: null means "not fetchable", a throwing fetch must
// never be reached.
const noTarball = async () => null;
const mustNotFetch = async () => { throw new Error('fetchTarball must not be called'); };

console.log('# upgrade');

// 1. Clean workspace with a baseline, offline: payload staged, no
//    tracked-payload warning, the baseline left in place, no reconstruction,
//    and no merge base — the failure warns but never fails the upgrade.
{
  const root = buildWorkspace({ baseline: true });
  try {
    const { out } = await captureConsole(() => upgradeWorkspace(root, { fetchTarball: noTarball }));
    const stderr = out.error.join('\n');
    check('no tracked-payload warning on a clean workspace',
      !stderr.includes('git rm -r --cached'));
    check('payload staged', existsSync(join(root, '.workspace-update', '.manifest.json')));
    check('freshly staged payload is not tracked', lsFilesPayload(root).length === 0);
    check('staging reported', out.log.join('\n').includes('Staged template payload'));
    check('existing baseline named as left in place',
      out.log.join('\n').includes('Template baseline already present'));
    check('no reconstructed baseline staged when one exists',
      !existsSync(join(root, '.workspace-update', '.template-baseline.reconstructed.json')));
    check('offline warns about the missing merge base',
      stderr.includes('no merge base staged for locally modified files'));
    check('no template base staged offline',
      !existsSync(join(root, '.workspace-update', '.template-base')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 2. Workspace tracking .workspace-update/ from a pre-v0.19 upgrade: the
//    warning fires and names the untrack command.
{
  const root = buildWorkspace({ baseline: true });
  try {
    // Simulate the old behavior: a payload committed tracked.
    const payload = join(root, '.workspace-update');
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, '.manifest.json'), '{"action":"upgrade"}\n');
    execSync('git add -f .workspace-update', { cwd: root, stdio: 'pipe' });
    execSync('git commit -q -m "track payload"', { cwd: root, stdio: 'pipe' });
    check('fixture really tracks the payload', lsFilesPayload(root).length > 0);

    const { out } = await captureConsole(() => upgradeWorkspace(root, { fetchTarball: mustNotFetch }));
    const stderr = out.error.join('\n');
    check('tracked-payload warning fires', stderr.includes('.workspace-update/') && stderr.includes('tracked by git'));
    check('warning names the untrack command', stderr.includes('git rm -r --cached .workspace-update'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 3. Not a git repo at all: staging still works, warning stays silent.
{
  const root = mkdtempSync(join(tmpdir(), 'upgrade-nogit-'));
  try {
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({
      workspace: { name: 'demo', initialized: true, templateVersion: '0.15.0' },
      repos: {},
    }, null, 2) + '\n');
    const { out } = await captureConsole(() => upgradeWorkspace(root, { fetchTarball: noTarball }));
    check('no warning outside a git repo', !out.error.join('\n').includes('tracked by git'));
    check('payload staged outside a git repo', existsSync(join(root, '.workspace-update', '.manifest.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 4. --upgrade installs the payload's workspace-update skill, REPLACING
//    whatever old copy the workspace carries. An old SKILL.md that matches
//    neither the payload's copy nor any known-shipped copy is the operator's
//    own edit — it is backed up before the swap (gh:186).
{
  const root = buildWorkspace({ baseline: true });
  try {
    // An outdated installed skill with a stale extra file.
    const oldSkill = join(root, '.claude', 'skills', 'workspace-update');
    mkdirSync(oldSkill, { recursive: true });
    writeFileSync(join(oldSkill, 'SKILL.md'), '# old flow\n');
    writeFileSync(join(oldSkill, 'OLD-EXTRA.md'), 'stale\n');

    const { out } = await captureConsole(() => upgradeWorkspace(root, { fetchTarball: noTarball }));
    const newSkill = readFileSync(join(oldSkill, 'SKILL.md'), 'utf8');
    check('installed skill is the payload copy, not the old one',
      newSkill === readFileSync(join(root, '.workspace-update', '.claude', 'skills', 'workspace-update', 'SKILL.md'), 'utf8')
      && newSkill !== '# old flow\n');
    check('stale files inside the old skill do not survive', !existsSync(join(oldSkill, 'OLD-EXTRA.md')));
    check('skill install reported', out.log.join('\n').includes('workspace-update skill'));
    check('a locally modified old skill is backed up',
      readFileSync(join(oldSkill, 'SKILL.md.local-backup'), 'utf8') === '# old flow\n');
    check('backup reported', out.log.join('\n').includes('SKILL.md.local-backup'));
    // The staged payload itself is unchanged: its skill directory stays.
    check('payload still carries the skill directory',
      existsSync(join(root, '.workspace-update', '.claude', 'skills', 'workspace-update', 'SKILL.md')));
    check('no staging directory left behind',
      !existsSync(join(root, '.claude', 'skills', '.workspace-update.incoming')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 4b. A PRISTINE old skill — its bytes match what the installed version
//     shipped (the reconstructed baseline records the hash) — replaces
//     without a backup: nothing of the operator's is at risk.
{
  // The tarball of the installed version shipped exactly this skill.
  const PRISTINE_TARBALL = makeTarball([
    ['package/template/.claude/skills/workspace-update/SKILL.md', '# pristine old flow\n'],
    ['package/template/.claudeignore', 'scratch/\n'],
  ]);
  const root = buildWorkspace({ templateVersion: '0.15.0' });
  try {
    const oldSkill = join(root, '.claude', 'skills', 'workspace-update');
    mkdirSync(oldSkill, { recursive: true });
    writeFileSync(join(oldSkill, 'SKILL.md'), '# pristine old flow\n');
    await captureConsole(() => upgradeWorkspace(root, { fetchTarball: async () => PRISTINE_TARBALL }));
    check('pristine old skill replaced without a backup',
      !existsSync(join(oldSkill, 'SKILL.md.local-backup'))
      && readFileSync(join(oldSkill, 'SKILL.md'), 'utf8') !== '# pristine old flow\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // The same workspace but with the operator's own edit on top: backed up.
  const editedRoot = buildWorkspace({ templateVersion: '0.15.0' });
  try {
    const oldSkill = join(editedRoot, '.claude', 'skills', 'workspace-update');
    mkdirSync(oldSkill, { recursive: true });
    writeFileSync(join(oldSkill, 'SKILL.md'), '# my customized flow\n');
    await captureConsole(() => upgradeWorkspace(editedRoot, { fetchTarball: async () => PRISTINE_TARBALL }));
    check('a customized old skill is backed up when the shipped hash is known',
      readFileSync(join(oldSkill, 'SKILL.md.local-backup'), 'utf8') === '# my customized flow\n');
  } finally {
    rmSync(editedRoot, { recursive: true, force: true });
  }
}

// 4c. A copy that fails partway leaves the installed skill in place — the
//     swap happens only after the staging copy succeeded.
{
  const root = buildWorkspace({ baseline: true });
  try {
    const oldSkill = join(root, '.claude', 'skills', 'workspace-update');
    mkdirSync(oldSkill, { recursive: true });
    writeFileSync(join(oldSkill, 'SKILL.md'), '# old flow\n');
    const { out } = await captureConsole(() => upgradeWorkspace(root, {
      fetchTarball: noTarball,
      copySkill: () => { throw new Error('disk full'); },
    }));
    check('a failing copy keeps the installed skill',
      readFileSync(join(oldSkill, 'SKILL.md'), 'utf8') === '# old flow\n');
    check('a failing copy warns', out.error.join('\n').includes('could not install the current workspace-update skill'));
    check('a failing copy leaves no staging directory',
      !existsSync(join(root, '.claude', 'skills', '.workspace-update.incoming')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 5. No baseline + old live-name tarball: reconstruction stages a baseline
//    for the INSTALLED version INSIDE THE PAYLOAD — never the launcher —
//    marked reconstructed (gh:186), and the same fetch stages the template
//    content as the merge base under live names (gh:193).
{
  const root = buildWorkspace({ templateVersion: '0.15.0' });
  try {
    const { out } = await captureConsole(() => upgradeWorkspace(root, {
      fetchTarball: async (version) => (version === '0.15.0' ? OLD_LAYOUT_TARBALL : null),
    }));
    const baselinePath = join(root, '.workspace-update', '.template-baseline.reconstructed.json');
    check('reconstructed baseline staged in the payload', existsSync(baselinePath));
    check('launcher gets no new baseline file',
      !existsSync(join(root, '.claude', '.template-baseline.json')));
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    check('baseline records the installed version', baseline.templateVersion === '0.15.0');
    check('baseline is marked reconstructed', baseline.reconstructed === true);
    check('live-name layout hashes map to installed keys',
      baseline.files['.claude/hooks/session-start.mjs'] === sha('// hooks v0.15\n'));
    check('.mcp.json baselined from the old live name',
      baseline.files['.mcp.json'] === sha('{"mcpServers":{}}\n'));
    check('non-verbatim payload roots are not baselined',
      !Object.keys(baseline.files).some((k) => k.endsWith('.tmpl') || k.startsWith('package')));
    check('reconstruction reported', out.log.join('\n').includes('Reconstructed template baseline'));
    check('reconstruction names its staged location',
      out.log.join('\n').includes('.template-baseline.reconstructed.json'));
    check('the fetch is announced on stderr before it can stall',
      out.error.join('\n').includes('Fetching the v0.15.0 template as the merge base'));

    const base = join(root, '.workspace-update', '.template-base');
    check('merge base staged in the payload',
      existsSync(join(base, '.claude', 'hooks', 'session-start.mjs')));
    check('merge base carries the tarball content',
      readFileSync(join(base, '.claude', 'hooks', 'session-start.mjs'), 'utf8') === '// hooks v0.15\n');
    check('merge base uses live names only',
      !existsSync(join(base, '_claude')) && !existsSync(join(base, '_mcp.json')));
    check('merge base keeps non-verbatim files out',
      !existsSync(join(base, 'CLAUDE.md.tmpl')));
    check('base staging reported',
      out.log.join('\n').includes('.template-base'));
    // The invariant template-merge.mjs relies on: what the baseline
    // records is exactly what the base holds.
    check('staged base hashes to the reconstructed baseline entry',
      hashFile(join(base, '.claude', 'hooks', 'session-start.mjs')) === baseline.files['.claude/hooks/session-start.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 6. No baseline + new inert-name tarball: same reconstruction through the
//    _claude/_mcp.json layout, and the merge base lands under live names.
{
  const root = buildWorkspace({ templateVersion: '0.19.0' });
  try {
    await captureConsole(() => upgradeWorkspace(root, {
      fetchTarball: async () => NEW_LAYOUT_TARBALL,
    }));
    const baseline = JSON.parse(
      readFileSync(join(root, '.workspace-update', '.template-baseline.reconstructed.json'), 'utf8'));
    check('inert-name layout maps to installed keys',
      baseline.files['.claude/hooks/session-start.mjs'] === sha('// hooks v0.19\n'));
    check('_mcp.json baselined as .mcp.json',
      baseline.files['.mcp.json'] === sha('{"mcpServers":{}}\n'));
    check('baseline marked reconstructed', baseline.reconstructed === true);
    check('launcher still has no baseline of its own',
      !existsSync(join(root, '.claude', '.template-baseline.json')));
    const base = join(root, '.workspace-update', '.template-base');
    check('inert layout stages the base under live names',
      readFileSync(join(base, '.claude', 'hooks', 'session-start.mjs'), 'utf8') === '// hooks v0.19\n');
    check('_mcp.json staged into the base as .mcp.json',
      readFileSync(join(base, '.mcp.json'), 'utf8') === '{"mcpServers":{}}\n');
    check('no inert names inside the base',
      !existsSync(join(base, '_claude')) && !existsSync(join(base, '_mcp.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 7. Fetch failure and unknown version: warn and continue — the upgrade
//    itself never fails, and the payload plus skill still land.
{
  const root = buildWorkspace({ templateVersion: '0.15.0' });
  try {
    const { out } = await captureConsole(() => upgradeWorkspace(root, { fetchTarball: noTarball }));
    const stderr = out.error.join('\n');
    check('fetch failure warns about the missing baseline',
      stderr.includes('no template baseline written'));
    check('fetch failure names the per-file fallback',
      stderr.includes('ask about every changed file'));
    check('no baseline written on fetch failure',
      !existsSync(join(root, '.claude', '.template-baseline.json')));
    check('no reconstructed baseline staged on fetch failure',
      !existsSync(join(root, '.workspace-update', '.template-baseline.reconstructed.json')));
    check('no template base staged on fetch failure',
      !existsSync(join(root, '.workspace-update', '.template-base')));
    check('upgrade continues after fetch failure',
      existsSync(join(root, '.workspace-update', '.manifest.json'))
      && existsSync(join(root, '.claude', 'skills', 'workspace-update', 'SKILL.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 8. A corrupt tarball is a warning, not a crash.
{
  const root = buildWorkspace({ templateVersion: '0.15.0' });
  try {
    const { out } = await captureConsole(() => upgradeWorkspace(root, {
      fetchTarball: async () => Buffer.from('not a tarball at all'),
    }));
    check('corrupt tarball warns', out.error.join('\n').includes('no template baseline written'));
    check('corrupt tarball does not fail the upgrade',
      existsSync(join(root, '.workspace-update', '.manifest.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 9. No usable templateVersion: named warning, no network attempt.
{
  const root = buildWorkspace({ templateVersion: null });
  try {
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({
      workspace: { name: 'demo', initialized: true },
      repos: {},
    }, null, 2) + '\n');
    const { out } = await captureConsole(() => upgradeWorkspace(root, { fetchTarball: mustNotFetch }));
    check('missing templateVersion warns', out.error.join('\n').includes('no templateVersion'));
    check('no baseline written without a version',
      !existsSync(join(root, '.claude', '.template-baseline.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 10. An existing baseline is left alone: no rewrite, nothing reconstructed
//     alongside it. The fetch still happens (the merge base needs the
//     content) but its result never touches the baseline.
{
  const root = buildWorkspace({ baseline: true });
  try {
    const before = readFileSync(join(root, '.claude', '.template-baseline.json'), 'utf8');
    const { out } = await captureConsole(() => upgradeWorkspace(root, { fetchTarball: noTarball }));
    check('existing baseline untouched',
      readFileSync(join(root, '.claude', '.template-baseline.json'), 'utf8') === before);
    check('reconstruction not reported', !out.log.join('\n').includes('Reconstructed'));
    check('no reconstructed baseline staged alongside',
      !existsSync(join(root, '.workspace-update', '.template-baseline.reconstructed.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 11. A CORRUPT baseline file is as good as none: reconstruction runs and
//     stages its result in the payload; the broken launcher file itself is
//     left exactly as it was (gh:186).
{
  const root = buildWorkspace({ templateVersion: '0.15.0' });
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.template-baseline.json'), '{ not json at all\n');
    const { out } = await captureConsole(() => upgradeWorkspace(root, {
      fetchTarball: async () => OLD_LAYOUT_TARBALL,
    }));
    check('a corrupt baseline does not block reconstruction',
      existsSync(join(root, '.workspace-update', '.template-baseline.reconstructed.json')));
    check('the corrupt file is left as it was',
      readFileSync(join(root, '.claude', '.template-baseline.json'), 'utf8') === '{ not json at all\n');
    check('reconstruction reported despite the corrupt file',
      out.log.join('\n').includes('Reconstructed template baseline'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 12. A workspace WITH a baseline still gets the merge base: the fetch now
//     serves the base staging alone, and no reconstruction happens (gh:193).
{
  const root = buildWorkspace({ baseline: true, templateVersion: '0.15.0' });
  try {
    const { out } = await captureConsole(() => upgradeWorkspace(root, {
      fetchTarball: async () => OLD_LAYOUT_TARBALL,
    }));
    const base = join(root, '.workspace-update', '.template-base');
    check('merge base staged beside an existing baseline',
      readFileSync(join(base, '.claude', 'hooks', 'session-start.mjs'), 'utf8') === '// hooks v0.15\n');
    check('no reconstruction next to an existing baseline',
      !existsSync(join(root, '.workspace-update', '.template-baseline.reconstructed.json'))
        && !out.log.join('\n').includes('Reconstructed'));
    check('existing baseline named as left in place',
      out.log.join('\n').includes('Template baseline already present'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 13. The offline skip with a baseline present: the upgrade completes, only
//     the merge base is missing, and the warning says exactly that — not the
//     pre-baseline fallback wording.
{
  const root = buildWorkspace({ baseline: true, templateVersion: '0.15.0' });
  try {
    const { out } = await captureConsole(() => upgradeWorkspace(root, { fetchTarball: noTarball }));
    const stderr = out.error.join('\n');
    check('offline with baseline warns about the merge base only',
      stderr.includes('no merge base staged') && !stderr.includes('ask about every changed file'));
    check('no template base staged', !existsSync(join(root, '.workspace-update', '.template-base')));
    check('the upgrade still completes',
      existsSync(join(root, '.workspace-update', '.manifest.json'))
      && existsSync(join(root, '.claude', 'skills', 'workspace-update', 'SKILL.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 14. Staging is best-effort end to end: a failing baseline build warns and
//     still stages the merge base; a base copy that fails partway removes
//     the partial base — never trusted as an ancestor — and the upgrade
//     itself never fails (gh:193).
{
  const root = buildWorkspace({ templateVersion: '0.15.0' });
  try {
    const { out } = await captureConsole(() => upgradeWorkspace(root, {
      fetchTarball: async () => OLD_LAYOUT_TARBALL,
      buildBase: () => { throw new Error('EACCES: permission denied'); },
    }));
    const stderr = out.error.join('\n');
    check('baseline build failure warns', stderr.includes('no template baseline written'));
    check('no reconstructed baseline on a build failure',
      !existsSync(join(root, '.workspace-update', '.template-baseline.reconstructed.json')));
    check('the merge base still stages after a baseline failure',
      existsSync(join(root, '.workspace-update', '.template-base', '.claude', 'hooks', 'session-start.mjs')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 15. A base copy failing MID-WAY leaves a partial .template-base on disk
//     for a moment — it must be removed, not left where template-merge
//     could trust it.
{
  const root = buildWorkspace({ baseline: true, templateVersion: '0.15.0' });
  try {
    let calls = 0;
    const { out } = await captureConsole(() => upgradeWorkspace(root, {
      fetchTarball: async () => OLD_LAYOUT_TARBALL,
      copyBase: (src, dest, opts) => {
        if (calls++ > 0) throw new Error('disk full');
        cpSync(src, dest, opts); // the first root lands, the rest fail
      },
    }));
    check('a mid-copy failure warns about the merge base',
      out.error.join('\n').includes('could not stage the merge base'));
    check('the partial base is removed',
      !existsSync(join(root, '.workspace-update', '.template-base')));
    check('the upgrade completes after a base-copy failure',
      existsSync(join(root, '.workspace-update', '.manifest.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
