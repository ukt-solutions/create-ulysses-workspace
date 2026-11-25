#!/usr/bin/env node
// Unit tests for upgrade.mjs
// Run: node lib/upgrade.test.mjs
//
// Covers the tracked-payload warning (.workspace-update/ is gitignored
// from v0.19.0, but a workspace upgraded from an older template may still
// carry a tracked payload), the workspace-update skill bootstrap (--upgrade
// installs the payload's copy so the workspace never runs an outdated
// flow), baseline reconstruction for pre-baseline workspaces (gh:186), the
// .template-base/ merge-base staging every upgrade attempts (gh:193), and
// the downgrade guard that keeps an older CLI from staging its template
// over a newer workspace. The tarball fetch is injected, so the suite never
// touches the network; the guard's CLI-level checks run bin/create.mjs in a
// child process that can reach neither the registry nor npm.
import { upgradeWorkspace, checkDowngrade } from './upgrade.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { fileURLToPath } from 'url';

let failed = 0;
let passed = 0;
let skipped = 0;
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

// process.exit never returns, so the stand-in records the code and throws:
// code after an exit must not run here any more than in the CLI.
const EXITED = Symbol('exited');
async function captureExit(fn) {
  const origExit = process.exit;
  const codes = [];
  process.exit = (code) => { codes.push(code); throw EXITED; };
  try {
    return { codes, result: await fn() };
  } catch (err) {
    if (err !== EXITED) throw err;
    return { codes };
  } finally {
    process.exit = origExit;
  }
}

// Both at once: what the run printed, and the exit codes it asked for. The
// console capture sits outside so the lines printed before an exit survive.
async function captureRun(fn) {
  const { out, result } = await captureConsole(() => captureExit(fn));
  return { out, codes: result.codes };
}

// `baselineFiles` is the files map of the baseline that `baseline: true`
// writes — by default one that knows nothing of the workspace-update skill.
function buildWorkspace({
  templateVersion = '0.15.0', baseline = false, baselineFiles = { '.claude/hooks/a.mjs': '0'.repeat(64) },
} = {}) {
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
      files: baselineFiles,
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

// ---- the downgrade guard's fixtures ----

// The template version this checkout's CLI ships, and the one just above it
// on the same channel: a workspace on the newer one is ahead of the CLI
// running --upgrade.
const here = dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
const newerVersion = pkgVersion.replace(
  /^(\d+)\.(\d+)\.(\d+)(.*)$/,
  (_, M, m, p, pre) => `${M}.${Number(m) + 1}.${p}${pre}`,
);
// The dist-tag a workspace on `newerVersion` upgrades through: its own
// pre-release channel, or none for a stable release.
const newerChannel = newerVersion.includes('-') ? newerVersion.split('-')[1].split('.')[0] : null;

function writeNewerWorkspace(root) {
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({
    workspace: { name: 'demo', initialized: true, templateVersion: newerVersion },
    repos: {},
  }, null, 2) + '\n');
}

// bin/create.mjs the way a shell runs it, so the exit status is the real
// one. The child can reach nothing: its registry setting is not a URL (the
// fetch fails before a socket opens) and its PATH holds no npm, so the
// tarball fetch fails at once and offline — the twin of the injected
// noTarball.
function runCli(root, ...flags) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'PATH') env[key] = value;
  }
  env.PATH = join(root, 'no-bin');
  env.NPM_CONFIG_REGISTRY = 'not-a-registry';
  return spawnSync(process.execPath, [join(here, '..', 'bin', 'create.mjs'), '--upgrade', root, ...flags], {
    encoding: 'utf-8', env, timeout: 60000,
  });
}

// The last stderr line of a child run, for a failing check's label.
const lastLine = (r) => (r.stderr || '').trim().split('\n').pop();

// bin/create.mjs loads the interactive prompt library up front, so the
// CLI-level checks need the package's one dependency installed.
let cliRuns = true;
try { import.meta.resolve('prompts'); } catch { cliRuns = false; }

// ---- the workspace-update skill backup's fixtures ----

// What the INSTALLED version shipped as its workspace-update skill: the
// tarball carrying it, and the baseline entry recording it. The payload's
// copy is this checkout's own skill, which it does not resemble — so in 4b
// and 4d only a baseline can vouch for the installed file.
const SKILL_KEY = '.claude/skills/workspace-update/SKILL.md';
const SKILL_BACKUP = 'SKILL.md.local-backup';
const SHIPPED_SKILL = '# shipped old flow\n\nApplies the payload the old way.\n';
const SHIPPED_SKILL_HASH = sha(SHIPPED_SKILL);
const SHIPPED_TARBALL = makeTarball([
  ['package/template/.claude/skills/workspace-update/SKILL.md', SHIPPED_SKILL],
  ['package/template/.claudeignore', 'scratch/\n'],
]);
// A baseline with the shipped skill recorded beside another template file.
const RECORDED_BASELINE = { '.claude/hooks/a.mjs': '0'.repeat(64), [SKILL_KEY]: SHIPPED_SKILL_HASH };

// Install `installed` as the workspace's workspace-update skill, run
// --upgrade, and return where the skill lives and what the run logged.
async function upgradeWithInstalledSkill(root, installed, opts) {
  const skillDir = join(root, '.claude', 'skills', 'workspace-update');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), installed);
  const { out } = await captureConsole(() => upgradeWorkspace(root, opts));
  return { skillDir, log: out.log.join('\n') };
}

// The backup decision as the operator meets it: the payload's copy replaces
// the skill either way, and a backup — the installed file, byte for byte —
// is left and announced exactly when `backedUp` says.
function checkSkillBackup(label, root, { skillDir, log }, installed, backedUp) {
  check(`${label}: the payload's copy replaces the skill`,
    readFileSync(join(skillDir, 'SKILL.md'), 'utf8') === readFileSync(join(root, '.workspace-update', SKILL_KEY), 'utf8'));
  check(`${label}: ${backedUp ? 'a backup is left' : 'no backup is left'}`,
    existsSync(join(skillDir, SKILL_BACKUP)) === backedUp);
  check(`${label}: "modified locally" is ${backedUp ? '' : 'not '}reported`,
    log.includes('modified locally') === backedUp);
  if (backedUp) {
    check(`${label}: the backup is the installed file, untouched`,
      readFileSync(join(skillDir, SKILL_BACKUP), 'utf8') === installed);
  }
}

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
//     shipped — replaces without a backup or the message: nothing of the
//     operator's is at risk. A workspace without a baseline of its own has
//     that shipped hash only in the baseline --upgrade reconstructs from the
//     installed version's tarball (4d covers a workspace that carries one).
//     An operator's edit on top of the shipped skill is still backed up, and
//     still reported.
{
  // [label, the installed SKILL.md, whether a backup is expected]
  const cases = [
    ['a pristine old skill', SHIPPED_SKILL, false],
    ['a customized old skill', '# my customized flow\n', true],
  ];
  for (const [label, installed, backedUp] of cases) {
    const root = buildWorkspace();
    try {
      const run = await upgradeWithInstalledSkill(root, installed, { fetchTarball: async () => SHIPPED_TARBALL });
      check(`${label}: the shipped hash arrives as a reconstructed baseline`,
        JSON.parse(readFileSync(join(root, '.workspace-update', '.template-baseline.reconstructed.json'), 'utf8')).files[SKILL_KEY]
          === SHIPPED_SKILL_HASH);
      checkSkillBackup(label, root, run, installed, backedUp);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

// 4d. A workspace WITH a baseline of its own is never handed a reconstructed
//     one, so the shipped hash is that baseline's entry for the skill. An
//     installed SKILL.md still matching it is the installed version's own
//     copy: it replaces without a backup or the message, however much it
//     differs from the payload's copy. Line endings are not a difference —
//     the entry was recorded from LF bytes and both sides hash with CRLF
//     normalized — while an edit on top is. With nothing recording the
//     shipped hash (the baseline is silent about the file, or is absent and
//     nothing could be reconstructed) the old rule holds: whatever differs
//     from the payload is backed up. Offline throughout, so the workspace's
//     baseline is the only place a shipped hash can come from.
{
  // What the "no backup" rows rely on: the payload's copy is nothing like
  // the shipped skill, so only a baseline can tell an untouched copy from an
  // edit.
  check('the shipped skill differs from the payload copy',
    hashFile(join(here, '..', 'template', '_claude', 'skills', 'workspace-update', 'SKILL.md')) !== SHIPPED_SKILL_HASH);

  // [label, options for buildWorkspace, the installed SKILL.md, backed up?]
  const recorded = { baseline: true, baselineFiles: RECORDED_BASELINE };
  const cases = [
    ['a pristine installed skill', recorded, SHIPPED_SKILL, false],
    ['a CRLF checkout of it', recorded, SHIPPED_SKILL.replace(/\n/g, '\r\n'), false],
    ['the shipped skill with an edit on top', recorded, `${SHIPPED_SKILL}\n# my own step\n`, true],
    ['a baseline with no entry for the skill', { baseline: true }, SHIPPED_SKILL, true],
    ['no baseline, nothing reconstructed', { baseline: false }, SHIPPED_SKILL, true],
  ];
  for (const [label, workspace, installed, backedUp] of cases) {
    const root = buildWorkspace(workspace);
    try {
      const run = await upgradeWithInstalledSkill(root, installed, { fetchTarball: noTarball });
      check(`${label}: no reconstructed baseline is staged`,
        !existsSync(join(root, '.workspace-update', '.template-baseline.reconstructed.json')));
      checkSkillBackup(label, root, run, installed, backedUp);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

// ---- the downgrade guard ----

// 16. checkDowngrade is pure: true only for two published version strings
//     with toVersion the lower one.
{
  check('an older template is a downgrade',
    checkDowngrade('0.25.0-beta.0', '0.23.1-beta.0') === true);
  check('the same version is not a downgrade',
    checkDowngrade('0.25.0-beta.0', '0.25.0-beta.0') === false);
  check('a newer beta is not a downgrade',
    checkDowngrade('0.25.0-beta.0', '0.26.0-beta.0') === false);
  check('a release candidate above is not a downgrade',
    checkDowngrade('0.25.0-beta.0', '1.0.0-rc.0') === false);
  check('an unknown workspace version never blocks',
    checkDowngrade('unknown', '0.23.1-beta.0') === false);
  check('numeric prerelease identifiers compare as numbers',
    checkDowngrade('0.25.0-beta.10', '0.25.0-beta.2') === true);
  check('a release is above its own release candidate',
    checkDowngrade('1.0.0', '1.0.0-rc.0') === true);
  check('a release candidate is above an older beta',
    checkDowngrade('1.0.0-rc.0', '1.0.0-beta.9') === true);
  const unparsable = [undefined, null, '', '0.25', 'v0.25.0', '0.25.0+build.1', 0.25];
  check('a version that does not parse never blocks, on either side',
    unparsable.every((v) => !checkDowngrade(v, '0.23.1-beta.0') && !checkDowngrade('0.25.0-beta.0', v)));
}

// 17. A workspace ahead of this checkout's CLI: --upgrade exits non-zero
//     before writing anything — no payload, the installed skill untouched,
//     no fetch — and the refusal names both versions, the command to run
//     instead, the channel's dist-tag, and the flag that bypasses the guard.
{
  const root = buildWorkspace({ templateVersion: newerVersion });
  try {
    const installedSkill = join(root, '.claude', 'skills', 'workspace-update', 'SKILL.md');
    mkdirSync(dirname(installedSkill), { recursive: true });
    writeFileSync(installedSkill, '# installed flow\n');
    const { out, codes } = await captureRun(() => upgradeWorkspace(root, { fetchTarball: mustNotFetch }));
    const stderr = out.error.join('\n');
    check('a downgrade exits non-zero', codes.length === 1 && codes[0] === 1);
    check('the refusal names both versions',
      stderr.includes(`v${newerVersion}`) && stderr.includes(`v${pkgVersion}`));
    check("the refusal names a command at the workspace's version",
      stderr.includes(`npx @ulysses-ai/create-workspace@${newerVersion} --upgrade`));
    check(newerChannel
      ? `the refusal names the ${newerChannel} dist-tag as the shortcut`
      : "a stable workspace is not pointed at a dist-tag",
    newerChannel
      ? stderr.includes(`npx @ulysses-ai/create-workspace@${newerChannel} --upgrade`)
      : !stderr.includes('create-workspace@latest'));
    check('the refusal names the bypass flag', stderr.includes('--allow-downgrade'));
    check('no payload is staged for a downgrade', !existsSync(join(root, '.workspace-update')));
    check('the installed skill is left alone',
      readFileSync(installedSkill, 'utf8') === '# installed flow\n'
        && !existsSync(join(root, '.claude', 'skills', 'workspace-update', 'SKILL.md.local-backup')));
    check('nothing is reported as staged', !out.log.join('\n').includes('Staged template payload'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 17b. Nothing is removed either: a payload a newer CLI staged and nobody
//      has applied yet must survive the refusal — staging always begins by
//      emptying .workspace-update/.
{
  const root = buildWorkspace({ templateVersion: newerVersion });
  try {
    const pending = join(root, '.workspace-update', '.manifest.json');
    const staged = `{"templateVersion":"${newerVersion}","action":"upgrade"}\n`;
    mkdirSync(join(root, '.workspace-update'), { recursive: true });
    writeFileSync(pending, staged);
    const { codes } = await captureRun(() => upgradeWorkspace(root, { fetchTarball: mustNotFetch }));
    check('a pending payload from a newer CLI survives the refusal',
      codes.length === 1 && readFileSync(pending, 'utf8') === staged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 18. The same workspace with allowDowngrade: the guard stands aside and
//     the older template is staged, and reported as the downgrade it is.
{
  const root = buildWorkspace({ templateVersion: newerVersion });
  try {
    const { out, codes } = await captureRun(() => upgradeWorkspace(root, { allowDowngrade: true, fetchTarball: noTarball }));
    check('--allow-downgrade lets the upgrade through', codes.length === 0);
    const manifestPath = join(root, '.workspace-update', '.manifest.json');
    check('the older template is staged', existsSync(manifestPath));
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
    check('the manifest records the downgrade',
      manifest.action === 'upgrade'
        && manifest.fromVersion === newerVersion
        && manifest.templateVersion === pkgVersion);
    check('the downgrade is reported',
      out.log.join('\n').includes(`Staged template payload (v${newerVersion} → v${pkgVersion})`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 19. Nothing else trips the guard: a workspace on this CLI's own version,
//     and one whose templateVersion is not a version at all.
{
  const same = buildWorkspace({ templateVersion: pkgVersion });
  try {
    const { out, codes } = await captureRun(() => upgradeWorkspace(same, { fetchTarball: noTarball }));
    check("the CLI's own version is never refused", codes.length === 0);
    check('the same version still stages and says so',
      existsSync(join(same, '.workspace-update', '.manifest.json'))
        && out.log.join('\n').includes(`already on template v${pkgVersion}`));
  } finally {
    rmSync(same, { recursive: true, force: true });
  }

  const odd = buildWorkspace({ templateVersion: 'not-a-version' });
  try {
    const { codes } = await captureRun(() => upgradeWorkspace(odd, { fetchTarball: noTarball }));
    check('a templateVersion that is not a version never blocks',
      codes.length === 0 && existsSync(join(odd, '.workspace-update', '.manifest.json')));
  } finally {
    rmSync(odd, { recursive: true, force: true });
  }
}

// 20. The real entry point: bin/create.mjs in a child process, on a
//     workspace ahead of this checkout's CLI. Without the flag it exits 1
//     and leaves no payload; with --allow-downgrade it exits 0, having
//     staged the older template.
{
  const root = mkdtempSync(join(tmpdir(), 'upgrade-cli-'));
  try {
    writeNewerWorkspace(root);
    if (!cliRuns) {
      skipped += 7;
      console.log('  SKIP: 7 CLI-level checks — bin/create.mjs needs the `prompts` dependency (npm install)');
    } else {
      const refused = runCli(root);
      check(`the CLI exits 1 on a downgrade (status ${refused.status})`, refused.status === 1);
      check(`the CLI refusal names both versions (${lastLine(refused)})`,
        refused.stderr.includes(`v${newerVersion}`) && refused.stderr.includes(`v${pkgVersion}`));
      check(`the CLI refusal names the command to run instead (${lastLine(refused)})`,
        refused.stderr.includes(`npx @ulysses-ai/create-workspace@${newerVersion} --upgrade`));
      check(`the CLI refusal names the bypass flag (${lastLine(refused)})`,
        refused.stderr.includes('--allow-downgrade'));
      check('the CLI stages no payload for a downgrade', !existsSync(join(root, '.workspace-update')));

      const allowed = runCli(root, '--allow-downgrade');
      check(`the CLI exits 0 with --allow-downgrade (status ${allowed.status}: ${lastLine(allowed)})`,
        allowed.status === 0);
      const manifestPath = join(root, '.workspace-update', '.manifest.json');
      check('the CLI stages the older template with --allow-downgrade',
        existsSync(manifestPath)
          && JSON.parse(readFileSync(manifestPath, 'utf8')).templateVersion === pkgVersion);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 21. The real entry point on the workspace the false backup hit: one with a
//     baseline of its own and an untouched installed skill. bin/create.mjs
//     --upgrade replaces the skill and leaves no SKILL.md.local-backup
//     behind, and says nothing about a local modification. Offline like 20,
//     so the workspace's baseline is the only record of the shipped hash.
{
  if (!cliRuns) {
    skipped += 4;
    console.log('  SKIP: 4 CLI-level checks — bin/create.mjs needs the `prompts` dependency (npm install)');
  } else {
    const root = buildWorkspace({ baseline: true, baselineFiles: RECORDED_BASELINE });
    try {
      const baselinePath = join(root, '.claude', '.template-baseline.json');
      const baselineBefore = readFileSync(baselinePath, 'utf8');
      const skillDir = join(root, '.claude', 'skills', 'workspace-update');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), SHIPPED_SKILL);

      const run = runCli(root);
      check(`the CLI exits 0 (status ${run.status}: ${lastLine(run)})`, run.status === 0);
      check('the CLI replaces the skill with the payload copy',
        readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
          === readFileSync(join(root, '.workspace-update', SKILL_KEY), 'utf8'));
      check('the CLI leaves no SKILL.md.local-backup',
        !existsSync(join(skillDir, SKILL_BACKUP)) && !(run.stdout || '').includes('modified locally'));
      check('the CLI leaves the workspace baseline untouched',
        readFileSync(baselinePath, 'utf8') === baselineBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed${skipped > 0 ? `, ${skipped} skipped (bin/create.mjs needs the \`prompts\` dependency — npm install)` : ''}`);
