#!/usr/bin/env node
// Unit tests for team-roster.mjs
// Run: node template/_claude/lib/team-roster.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeRoster,
  lookup,
  suggestUser,
  sanitizeName,
  attributionHandle,
  identityFindings,
  sessionStartLines,
  folderFindings,
  listTeamFolders,
  readGitEmail,
  readForgeLogin,
} from './team-roster.mjs';

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

const codes = (findings) => findings.map((f) => f.code);

// The shape that motivated gh:133: one person, two folders.
const TEAM = {
  sam: { name: 'Sam Example', forge: 'sam-example', gitEmails: ['sam@example.com', 'SAM@work.example.com'] },
  alex: { name: 'Alex Example', forge: 'alex-example', gitEmails: ['alex@example.com'], aliases: ['alexw'] },
};

// ---------- normalizeRoster ----------

{
  assertEq(normalizeRoster(undefined).present, false, 'absent team → no roster');
  assertEq(normalizeRoster({}).present, false, 'empty team → no roster (an upgrade adding {} must not switch checks on)');
  const bad = normalizeRoster([]);
  assertEq(bad.present, false, 'array team → no roster');
  assertEq(bad.problems[0].severity, 'issue', 'array team → issue');
}

{
  const r = normalizeRoster(TEAM);
  assert(r.present, 'roster present');
  assertEq(r.problems, [], 'clean roster has no problems');
  assertEq(r.members.map((m) => m.key), ['sam', 'alex'], 'members keep key order');
  assertEq(r.members[0].forge, ['sam-example'], 'string forge becomes a list');
  assertEq(r.members[1].aliases, ['alexw'], 'aliases kept');
}

{
  const r = normalizeRoster({ 'bad name': {}, ok: 'nope' });
  assertEq(r.problems.filter((p) => p.severity === 'issue').length, 2, 'bad key and non-object entry are issues');
  assertEq(r.members, [], 'invalid members are dropped');
}

{
  const r = normalizeRoster({ alex: { gitEmail: 'a@example.com', forge: 7, name: '' } });
  const warnings = r.problems.filter((p) => p.severity === 'warning').map((p) => p.message);
  assert(warnings.some((m) => m.includes('unknown field "gitEmail"')), 'typo field warned');
  assert(warnings.some((m) => m.includes('forge must be')), 'non-string forge warned');
  assert(warnings.some((m) => m.includes('name must be')), 'empty name warned');
  assertEq(r.members.length, 1, 'member with ignored fields still listed');
}

{
  const r = normalizeRoster({
    a: { forge: 'Same', gitEmails: ['x@example.com'], aliases: ['b', 'shared'] },
    b: { forge: 'same', gitEmails: ['X@EXAMPLE.COM'], aliases: ['shared'] },
  });
  const issues = r.problems.filter((p) => p.severity === 'issue').map((p) => p.message);
  assert(issues.some((m) => m.includes('alias "b" is also a member')), 'alias colliding with a member key');
  assert(issues.some((m) => m.startsWith('alias "shared"')), 'alias claimed twice');
  assert(issues.some((m) => m.startsWith('forge login')), 'forge login claimed twice, case-insensitively');
  assert(issues.some((m) => m.startsWith('git email')), 'git email claimed twice, case-insensitively');
}

{
  const r = normalizeRoster({ a: { aliases: ['a', 'bad/alias'] } });
  assert(r.problems.some((p) => p.severity === 'warning' && p.message.includes('itself')), 'self-alias warned');
  assert(r.problems.some((p) => p.severity === 'issue' && p.message.includes('bad/alias')), 'invalid alias is an issue');
  assertEq(r.members[0].aliases, [], 'bad aliases dropped');
}

// ---------- lookup / suggest / handle ----------

const roster = normalizeRoster(TEAM);

{
  assertEq(lookup(roster, 'alex')?.via, 'key', 'lookup by key');
  assertEq(lookup(roster, 'alexw')?.member.key, 'alex', 'lookup resolves an alias to its owner');
  assertEq(lookup(roster, 'nobody'), null, 'unknown name');
  assertEq(lookup(normalizeRoster(undefined), 'alex'), null, 'no roster → no lookup');
}

{
  assertEq(suggestUser(roster, { forgeLogin: 'ALEX-EXAMPLE', osUser: 'whoever' }).user, 'alex', 'forge login wins');
  assertEq(suggestUser(roster, { forgeLogin: 'nobody', gitEmail: 'sam@work.example.com' }).source, 'git-email',
    'git email is second');
  const os = suggestUser(roster, { osUser: 'alexw' });
  assertEq([os.user, os.source], ['alex', 'os-alias'], 'an OS username that is an alias suggests its owner');
  assertEq(suggestUser(roster, { osUser: 'jane.doe' }).user, 'jane-doe', 'OS username is sanitized');
  assertEq(suggestUser(normalizeRoster(undefined), { osUser: 'zed' }), { user: 'zed', source: 'os', member: null },
    'no roster → OS username');
  assertEq(suggestUser(roster, {}).user, null, 'nothing known → no suggestion');
  assertEq(sanitizeName('...'), null, 'unsanitizable name');
}

{
  assertEq(attributionHandle(roster, { user: 'alex', forgeLogin: 'live' }), 'alex-example', 'handle from the roster');
  assertEq(attributionHandle(roster, { user: 'alexw' }), 'alex-example', 'handle through an alias');
  assertEq(attributionHandle(normalizeRoster({ zed: {} }), { user: 'zed', forgeLogin: 'zed-live' }), 'zed-live',
    'no roster login → live login');
  assertEq(attributionHandle(normalizeRoster(undefined), { user: 'zed' }), 'zed', 'nothing else → workspace.user');
}

// ---------- identityFindings ----------

{
  assertEq(identityFindings(normalizeRoster(undefined), { user: 'alexw' }), [], 'no roster → no findings');
  assertEq(identityFindings(roster, {}), [], 'no workspace.user → no findings (setup hint covers it)');
  assertEq(identityFindings(roster, { user: 'alex', forgeLogin: 'alex-example', gitEmail: 'alex@example.com' }), [],
    'consistent identity → no findings');
}

{
  const f = identityFindings(roster, { user: 'alexw', gitEmail: 'alex@example.com' });
  assertEq(codes(f), ['user-alias'], 'alias user warned; matching email is not a mismatch through the alias');
  assert(/--set-user alex\b/.test(f[0].message), 'alias warning names the fix');
}

{
  const f = identityFindings(roster, { user: 'zed' });
  assertEq(codes(f), ['user-unknown'], 'unknown user warned');
  assert(f[0].message.includes('--add zed --detect'), 'unknown-user warning names the fix');
}

{
  const f = identityFindings(roster, { user: 'sam', forgeLogin: 'alex-example', gitEmail: 'alex@example.com' });
  assertEq(codes(f), ['forge-mismatch', 'email-mismatch'], 'someone else’s login and email both flagged');
  assert(f.every((x) => x.severity === 'warning'), 'mismatches are warnings');
}

{
  const f = identityFindings(roster, { user: 'sam', forgeLogin: 'new-login', gitEmail: 'laptop@example.com' });
  assertEq(codes(f), ['forge-unrecorded', 'email-unrecorded'], 'unclaimed login and email suggested for recording');
  assert(f.every((x) => x.severity === 'info'), 'unrecorded identities are info');
}

// ---------- sessionStartLines ----------

{
  const lines = sessionStartLines(roster, { user: 'alexw', gitEmail: 'sam@example.com' });
  assertEq(lines.length, 2, 'alias and email mismatch both printed');
  assert(lines.every((l) => l.startsWith('Team identity: ')), 'lines are labelled');
  assert(lines[0].endsWith('--set-user alex --root .'), 'a closing command is left copyable (no trailing period)');
  assertEq(sessionStartLines(roster, { user: 'sam', gitEmail: 'laptop@example.com' }), [],
    'infos are not printed at session start');
  assertEq(sessionStartLines(normalizeRoster(undefined), { user: 'alexw' }), [], 'no roster → silent');
}

// ---------- folderFindings ----------

{
  assertEq(folderFindings(normalizeRoster(undefined), ['x']), [], 'no roster → no folder findings');
  const f = folderFindings(roster, ['alex', 'alexw', 'sam', 'stray']);
  assertEq(f.map((x) => [x.folder, x.code]), [['alexw', 'alias-folder'], ['stray', 'orphan-folder']],
    'alias and orphan folders found; member folders pass');
  assert(f[0].message.includes('--merge-alias alexw'), 'alias-folder finding names the merge');
}

// Names that differ only in case are one folder on macOS and Windows.
{
  const issues = (team) => normalizeRoster(team).problems.filter((p) => p.severity === 'issue').map((p) => p.message);
  assert(issues({ alex: { aliases: ['Alex'] } }).some((m) => m.includes('only in case')), 'case-only self-alias is an issue');
  assert(issues({ alex: {}, Alex: {} }).some((m) => m.startsWith('member name "alex"')), 'two keys differing in case');
  assert(issues({ alex: { aliases: ['SAM'] }, sam: {} }).some((m) => m.includes('is also a member')),
    'an alias equal to another member ignoring case');
  assert(issues({ a: { aliases: ['X'] }, b: { aliases: ['x'] } }).some((m) => m.startsWith('alias "x"')),
    'one alias claimed twice ignoring case');
  assertEq(issues(TEAM), [], 'the fixture roster stays clean');
}

// ---------- readers ----------

{
  const root = mkdtempSync(join(tmpdir(), 'team-roster-'));
  const tm = join(root, 'workspace-context', 'team-member');
  mkdirSync(join(tm, 'alice', 'sub'), { recursive: true });
  writeFileSync(join(tm, 'alice', 'sub', 'note.md'), 'x');
  mkdirSync(join(tm, 'empty', 'deeper'), { recursive: true });
  writeFileSync(join(tm, 'README.md'), 'not a folder');
  assertEq(listTeamFolders(root), ['alice'], 'folders with files only; files and empty dirs skipped');
  assertEq(listTeamFolders(join(root, 'nope')), [], 'missing team-member dir');
  if (process.platform !== 'win32') {
    // A link loop must not hang the walk; a symlinked folder is not a folder.
    mkdirSync(join(tm, 'looped'));
    symlinkSync(join(tm, 'looped'), join(tm, 'looped', 'self'));
    symlinkSync(join(tm, 'alice'), join(tm, 'linked'));
    assertEq(listTeamFolders(root), ['alice', 'looped'], 'symlinks are content, never descended into');
  }
  rmSync(root, { recursive: true, force: true });
}

{
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push([cmd, ...args, opts?.env?.GITLAB_HOST || '']);
    if (cmd === 'git') return { status: 0, stdout: 'me@example.com\n' };
    if (cmd === 'gh') return { status: 0, stdout: 'me-gh\n' };
    if (cmd === 'glab') return { status: 0, stdout: JSON.stringify({ username: 'me-gl' }) };
    return { status: 1 };
  };
  assertEq(readGitEmail('/r', { spawnFn: spawn }), 'me@example.com', 'git email read');
  assertEq(readForgeLogin({}, { spawnFn: spawn }), 'me-gh', 'GitHub by default');
  assertEq(readForgeLogin({ forge: { type: 'gitlab', host: 'gl.example' } }, { spawnFn: spawn }), 'me-gl', 'GitLab login');
  assert(calls.some((c) => c[0] === 'glab' && c.includes('gl.example') && c[c.length - 1] === 'gl.example'),
    'GitLab host passed as --hostname and GITLAB_HOST');
  assertEq(readForgeLogin({ forge: false }, { spawnFn: spawn }), null, 'forge disabled → null');
  const failing = () => ({ status: 1, stdout: '' });
  assertEq(readForgeLogin({}, { spawnFn: failing }), null, 'signed-out CLI → null');
  assertEq(readGitEmail('/r', { spawnFn: failing }), null, 'no git email → null');
  const throwing = () => { throw new Error('ENOENT'); };
  assertEq(readForgeLogin({}, { spawnFn: throwing }), null, 'missing CLI → null');
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
