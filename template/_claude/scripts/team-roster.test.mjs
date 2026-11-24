#!/usr/bin/env node
// Unit tests for team-roster.mjs (the CLI)
// Run: node template/_claude/scripts/team-roster.test.mjs
//
// Each test builds a throwaway workspace under os.tmpdir(). git runs for
// real (the merge relies on git mv); gh and glab are faked so nothing
// touches the network.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, parseArgs } from './team-roster.mjs';
import { renderClaudeLocal } from './generate-claude-local.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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

function assertThrows(fn, matcher, msg) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${msg} (expected throw)`);
  } catch (e) {
    if (matcher.test(e.message)) { passed++; }
    else { failed++; console.error(`  FAIL: ${msg}\n    error: ${e.message}`); }
  }
}

const TEAM = {
  myron: { name: 'Myron', forge: 'myron-gh', gitEmails: ['myron@example.com'] },
  andre: { name: 'Andre', forge: 'andre-gh', gitEmails: ['andre@example.com'], aliases: ['mccar'] },
};

/** Real git; gh answers with `login` (null = signed out) and records the call. */
function fakeSpawn(login = null, calls = []) {
  return (cmd, args, opts) => {
    if (cmd === 'git') return spawnSync(cmd, args, opts);
    calls.push(cmd);
    if (cmd === 'gh' && login) return { status: 0, stdout: `${login}\n` };
    return { status: 1, stdout: '', stderr: 'not signed in' };
  };
}

function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function workspace({ team = TEAM, user = null, email = 'andre@example.com', gitRepo = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'team-roster-cli-'));
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace: { name: 't', team }, repos: {} }, null, 2) + '\n');
  if (user) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ workspace: { user }, other: 1 }, null, 2));
  }
  if (gitRepo) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', email);
    git(root, 'config', 'user.name', 'Tester');
  }
  return root;
}

function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true });
const TM = 'workspace-context/team-member';

// ---------- parseArgs ----------

{
  assertThrows(() => parseArgs([]), /pick one/, 'a command is required');
  assertThrows(() => parseArgs(['--check', '--whoami']), /pick one/, 'one command only');
  assertThrows(() => parseArgs(['--add']), /needs a value/, '--add needs a key');
  assertThrows(() => parseArgs(['--check', '--bogus']), /unknown argument/, 'unknown flag');
  const a = parseArgs(['--add', 'zed', '--forge', 'a', '--forge', 'b', '--email', 'z@x', '--detect']);
  assertEq([a.command, a.target, a.forge, a.emails, a.detect], ['add', 'zed', ['a', 'b'], ['z@x'], true], 'repeatable values');
}

// ---------- --suggest ----------

{
  const root = workspace({ email: 'nobody@example.com' });
  put(root, `${TM}/andre/a.md`, 'x');
  put(root, `${TM}/mccar/b.md`, 'y');
  const { out } = run(['--suggest', '--root', root, '--offline'], { spawnFn: fakeSpawn(), osUser: 'mccar' });
  assertEq([out.suggestion, out.source], ['andre', 'os-alias'], 'OS alias suggests the owner');
  assertEq(out.folders, ['andre', 'mccar'], 'folders listed');
  assertEq(out.aliases, { mccar: 'andre' }, 'alias map listed');
  const live = run(['--suggest', '--root', root], { spawnFn: fakeSpawn('MYRON-GH'), osUser: 'mccar' }).out;
  assertEq([live.suggestion, live.source], ['myron', 'forge'], 'forge login outranks the OS username');
  cleanup(root);
}

// ---------- --whoami ----------

{
  const root = workspace({ user: 'mccar' });
  const calls = [];
  const { out } = run(['--whoami', '--root', root], { spawnFn: fakeSpawn('ignored', calls) });
  assertEq([out.user, out.member, out.via, out.handle], ['mccar', 'andre', 'alias', 'andre-gh'], 'alias resolves to owner and handle');
  assertEq(calls, [], 'roster login answers without calling the forge');
  cleanup(root);
}

{
  const root = workspace({ user: 'zed', team: { zed: {} } });
  const { out } = run(['--whoami', '--root', root], { spawnFn: fakeSpawn('zed-live') });
  assertEq(out.handle, 'zed-live', 'no roster login → live login');
  const offline = run(['--whoami', '--root', root, '--offline'], { spawnFn: fakeSpawn('zed-live') }).out;
  assertEq(offline.handle, 'zed', 'offline → workspace.user');
  cleanup(root);
}

// ---------- --check ----------

{
  const root = workspace({ user: 'mccar' });
  put(root, `${TM}/andre/a.md`, 'x');
  put(root, `${TM}/mccar/b.md`, 'y');
  put(root, `${TM}/stray/c.md`, 'z');
  const { out, code } = run(['--check', '--root', root, '--offline'], { spawnFn: fakeSpawn() });
  assertEq(code, 0, 'warnings only → exit 0');
  assertEq(out.findings.map((f) => f.code).sort(), ['alias-folder', 'orphan-folder', 'user-alias'], 'all three problems found');
  assertEq(out.gitEmail, 'andre@example.com', 'git email read from the repo');
  cleanup(root);
}

{
  const root = workspace({ team: { a: { forge: 'same' }, b: { forge: 'SAME' } } });
  const { code } = run(['--check', '--root', root, '--offline'], { spawnFn: fakeSpawn() });
  assertEq(code, 1, 'a contradictory roster exits 1');
  cleanup(root);
}

// ---------- --add ----------

{
  const root = workspace({ email: 'zed@example.com' });
  const first = run(['--add', 'zed', '--name', 'Zed', '--detect', '--root', root], { spawnFn: fakeSpawn('zed-gh') }).out;
  assertEq(first.entry, { name: 'Zed', forge: 'zed-gh', gitEmails: ['zed@example.com'] }, 'detected identity recorded');
  assert(first.changed, 'workspace.json changed');
  const written = readFileSync(join(root, 'workspace.json'), 'utf8');
  assert(written.endsWith('}\n') && written.includes('\n  "workspace": {'), 'written as 2-space JSON with a newline');
  assertEq(JSON.parse(written).workspace.name, 't', 'other workspace keys kept');
  const again = run(['--add', 'zed', '--detect', '--root', root], { spawnFn: fakeSpawn('ZED-GH') }).out;
  assertEq(again.changed, false, 're-running is a no-op (case-insensitive union)');
  const more = run(['--add', 'zed', '--forge', 'zed-gl', '--email', 'zed@work.example', '--root', root], { spawnFn: fakeSpawn() }).out;
  assertEq(more.entry.forge, ['zed-gh', 'zed-gl'], 'a second login turns forge into a list');
  cleanup(root);
}

{
  const root = workspace({ email: 'andre@example.com' });
  const { out } = run(['--add', 'zed', '--detect', '--root', root], { spawnFn: fakeSpawn('myron-gh') });
  assertEq(out.entry, {}, 'identities owned by others are not copied');
  assertEq(out.notes.length, 2, 'both skips explained');
  assertThrows(() => run(['--add', 'zed', '--email', 'myron@example.com', '--root', root], { spawnFn: fakeSpawn() }),
    /contradict/, 'an explicit email owned by someone else is refused');
  assertThrows(() => run(['--add', 'mccar', '--root', root], { spawnFn: fakeSpawn() }), /alias of andre/,
    'adding an alias as a member is refused');
  assertThrows(() => run(['--add', 'bad/key', '--root', root], { spawnFn: fakeSpawn() }), /valid folder name/,
    'invalid key refused');
  cleanup(root);
}

// ---------- --set-user ----------

{
  const root = workspace({ user: 'mccar', gitRepo: false });
  writeFileSync(join(root, 'CLAUDE.local.md'), renderClaudeLocal('mccar'));
  const { out } = run(['--set-user', 'andre', '--root', root], { spawnFn: fakeSpawn() });
  assertEq([out.previous, out.user, out.claudeLocal, out.createdFolder], ['mccar', 'andre', 'written', true],
    'generated CLAUDE.local.md rewritten, folder created');
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
  assertEq([settings.workspace.user, settings.other], ['andre', 1], 'settings merged, not replaced');
  assertEq(readFileSync(join(root, 'CLAUDE.local.md'), 'utf8'), renderClaudeLocal('andre'), 'CLAUDE.local.md points at andre');
  assert(existsSync(join(root, TM, 'andre')), 'owner folder exists');
  cleanup(root);
}

{
  const root = workspace({ user: 'mccar', gitRepo: false });
  writeFileSync(join(root, 'CLAUDE.local.md'), `# mine\n${renderClaudeLocal('mccar')}\nmore notes\n`);
  assertEq(run(['--set-user', 'andre', '--root', root], { spawnFn: fakeSpawn() }).out.claudeLocal, 'import-updated',
    'a customised CLAUDE.local.md has only its import swapped');
  const text = readFileSync(join(root, 'CLAUDE.local.md'), 'utf8');
  assert(text.includes('# mine') && text.includes('team-member/andre/index.md') && !text.includes('mccar'), 'custom lines kept');
  writeFileSync(join(root, 'CLAUDE.local.md'), '# hand written\n');
  assertEq(run(['--set-user', 'myron', '--new', '--root', root], { spawnFn: fakeSpawn() }).out.claudeLocal, 'left-alone',
    'a CLAUDE.local.md without the import is left alone');
  cleanup(root);
}

{
  const root = workspace({ user: 'mccar', gitRepo: false });
  assertThrows(() => run(['--set-user', 'mccar', '--root', root], { spawnFn: fakeSpawn() }), /alias of andre/, 'alias refused');
  assertThrows(() => run(['--set-user', 'zed', '--root', root], { spawnFn: fakeSpawn() }), /not in the team roster/,
    'unknown name refused');
  assertEq(run(['--set-user', 'zed', '--new', '--root', root], { spawnFn: fakeSpawn() }).out.user, 'zed', '--new allows it');
  cleanup(root);
}

// ---------- --merge-alias ----------

function splitWorkspace() {
  const root = workspace({ user: 'andre' });
  put(root, '.gitignore', 'local-only-*\n');
  put(root, `${TM}/andre/research_x.md`, '---\nauthor: andre\n---\nmine\n');
  put(root, `${TM}/andre/design_w.md`, '---\nauthor: mccar\n---\nwritten from the alias machine\n');
  put(root, `${TM}/mccar/braindump_y.md`, '---\ntype: braindump\nauthor: mccar\n---\nbody mentions author: mccar\n');
  put(root, `${TM}/mccar/sub/handoff_z.md`, '---\nauthor: "mccar"\n---\n');
  put(root, `${TM}/mccar/index.md`, '# generated\n');
  put(root, 'workspace-context/shared/notes.md', 'see team-member/mccar/braindump_y.md\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  put(root, `${TM}/mccar/local-only-draft.md`, 'draft\n');
  return root;
}

{
  const root = splitWorkspace();
  const { out, code } = run(['--merge-alias', 'mccar', '--root', root], { spawnFn: fakeSpawn() });
  assertEq(code, 0, 'dry run exits 0');
  assertEq(out.dryRun, true, 'dry run by default');
  assertEq(out.owner, 'andre', 'owner resolved');
  assertEq(out.moves.map((m) => [m.to.split('/').slice(-2).join('/'), m.tracked]).sort(),
    [['andre/braindump_y.md', true], ['andre/local-only-draft.md', false], ['sub/handoff_z.md', true]],
    'tracked and local-only files planned');
  assertEq(out.drop, [{ path: `${TM}/mccar/index.md`, tracked: true }], 'generated index dropped');
  assertEq(out.references, ['workspace-context/shared/notes.md'], 'hand-written references listed');
  assertEq(out.retag, [`${TM}/andre/design_w.md`], "owner-folder file authored as the alias planned for retagging");
  assert(existsSync(join(root, TM, 'mccar', 'braindump_y.md')), 'dry run moves nothing');

  const applied = run(['--merge-alias', 'mccar', '--apply', '--root', root], { spawnFn: fakeSpawn() }).out;
  assertEq([applied.result.moved, applied.result.tracked, applied.result.authorsRewritten, applied.result.folderRemoved],
    [3, 2, 3, true], 'moved, authors rewritten (two moved, one already in place), alias folder removed');
  assert(readFileSync(join(root, TM, 'andre', 'design_w.md'), 'utf8').startsWith('---\nauthor: andre\n---'),
    'owner-folder file retagged');
  assert(!existsSync(join(root, TM, 'mccar')), 'alias folder gone');
  const y = readFileSync(join(root, TM, 'andre', 'braindump_y.md'), 'utf8');
  assert(y.includes('author: andre') && y.includes('body mentions author: mccar'), 'only frontmatter author rewritten');
  assert(readFileSync(join(root, TM, 'andre', 'sub', 'handoff_z.md'), 'utf8').includes('author: "andre"'), 'quoted author rewritten');
  const status = git(root, 'status', '--porcelain');
  assert(/^R. .*mccar\/braindump_y\.md -> .*andre\/braindump_y\.md$/m.test(status), 'git records a rename');
  assert(/^D. .*mccar\/index\.md$/m.test(status), 'tracked index removed from git');
  assert(existsSync(join(root, TM, 'andre', 'local-only-draft.md')), 'local-only draft moved');
  const rerun = run(['--merge-alias', 'mccar', '--root', root], { spawnFn: fakeSpawn() }).out;
  assertEq([rerun.moves.length, rerun.drop.length, rerun.retag.length], [0, 0, 0], 'a second run finds nothing to do');
  cleanup(root);
}

{
  const root = splitWorkspace();
  put(root, `${TM}/andre/braindump_y.md`, 'clash\n');
  const { out, code } = run(['--merge-alias', 'mccar', '--root', root], { spawnFn: fakeSpawn() });
  assertEq([code, out.conflicts.length], [1, 1], 'conflict reported in the dry run');
  assertThrows(() => run(['--merge-alias', 'mccar', '--apply', '--root', root], { spawnFn: fakeSpawn() }),
    /already exist/, 'apply refuses on conflict');
  assert(existsSync(join(root, TM, 'mccar', 'sub', 'handoff_z.md')), 'nothing moved on refusal');
  cleanup(root);
}

{
  const root = workspace();
  assertThrows(() => run(['--merge-alias', 'andre', '--root', root], { spawnFn: fakeSpawn() }), /member, not an alias/,
    'a member is not mergeable');
  assertThrows(() => run(['--merge-alias', 'zed', '--root', root], { spawnFn: fakeSpawn() }), /not in the team roster/,
    'an undeclared folder is not mergeable');
  cleanup(root);
}

// ---------- CLI process ----------

{
  const root = workspace({ user: 'mccar' });
  const script = join(here, 'team-roster.mjs');
  const r = spawnSync(process.execPath, [script, '--set-user', 'mccar', '--root', root], { encoding: 'utf8' });
  assertEq(r.status, 1, 'refusal exits 1');
  assert(JSON.parse(r.stdout).refused.includes('alias of andre'), 'refusal printed as JSON');
  const bad = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
  assertEq(bad.status, 2, 'usage error exits 2');
  const ok = spawnSync(process.execPath, [script, '--whoami', '--offline', '--root', root], { encoding: 'utf8' });
  assertEq([ok.status, JSON.parse(ok.stdout).handle], [0, 'andre-gh'], 'whoami from the CLI');
  cleanup(root);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
