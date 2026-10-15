#!/usr/bin/env node
// Tests for chat-record.mjs
// Run: node .claude/scripts/chat-record.test.mjs
//
// Every case builds its own fixture under tmpdir. Nothing reads the real
// workspace or the real session registry.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  recordPath, drawerPath, emptyRecord, readRecord, writeRecord,
  listRecords, reconcile, parseArgs, resolveChatName,
  addTask, removeTask, setScope, whoami, findOwner,
} from './chat-record.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; } else { failed += 1; console.error(`  FAIL: ${msg}`); }
}
function assertEq(a, e, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(e);
  if (x === y) { passed += 1; } else { failed += 1; console.error(`  FAIL: ${msg}\n    expected: ${y}\n    actual:   ${x}`); }
}
function throws(fn, msg) {
  try { fn(); failed += 1; console.error(`  FAIL: ${msg} (did not throw)`); } catch { passed += 1; }
}
const root = () => mkdtempSync(join(tmpdir(), 'chat-record-'));
const clean = (r) => rmSync(r, { recursive: true, force: true });

console.log('# write and read round-trip');
{
  const r = root();
  try {
    const rec = emptyRecord('alpha', 'sid-1');
    rec.tasks.push({ workItem: 'gh:1', branch: 'feature/x', repo: 'app' });
    writeRecord(r, rec);
    const back = readRecord(r, 'alpha');
    assertEq(back.sessionId, 'sid-1', 'sessionId round-trips');
    assertEq(back.tasks.length, 1, 'tasks round-trip');
    assert(recordPath(r, 'alpha').includes(join('workspace-scratchpad', 'chats')), 'lives under scratchpad/chats');
  } finally { clean(r); }
}

console.log('# a rename moves the record and keeps its state');
{
  const r = root();
  try {
    const rec = emptyRecord('old-name', 'sid-7');
    rec.concerns.push('engine');
    rec.tasks.push({ workItem: 'gh:9', branch: 'feature/y', repo: 'app' });
    writeRecord(r, rec);

    const res = reconcile(r, { sessionId: 'sid-7', name: 'new-name' });
    assertEq(res.renamed, { from: 'old-name', to: 'new-name' }, 'rename reported with correct from');
    assert(!existsSync(recordPath(r, 'old-name')), 'old record file is gone');
    const moved = readRecord(r, 'new-name');
    assertEq(moved.sessionId, 'sid-7', 'sessionId preserved across rename');
    assertEq(moved.concerns, ['engine'], 'concerns survive the rename');
    assertEq(moved.tasks.length, 1, 'tasks survive the rename');
    assertEq(moved.chat, 'new-name', 'chat field updated');
  } finally { clean(r); }
}

console.log('# the drawer follows the rename');
{
  const r = root();
  try {
    writeRecord(r, emptyRecord('before', 'sid-8'));
    mkdirSync(drawerPath(r, 'before'), { recursive: true });
    writeFileSync(join(drawerPath(r, 'before'), 'braindump_idea.md'), 'thinking\n');

    reconcile(r, { sessionId: 'sid-8', name: 'after' });
    assert(existsSync(join(drawerPath(r, 'after'), 'braindump_idea.md')), 'drawer contents moved with the rename');
    assert(!existsSync(drawerPath(r, 'before')), 'old drawer is gone');
  } finally { clean(r); }
}

console.log('# a first-seen chat gets a record created');
{
  const r = root();
  try {
    const res = reconcile(r, { sessionId: 'sid-new', name: 'fresh' });
    assert(res.created === true, 'created flag set');
    const rec = readRecord(r, 'fresh');
    assertEq(rec.sessionId, 'sid-new', 'new record carries the sessionId');
    assertEq(rec.tasks, [], 'new record starts with no tasks');
  } finally { clean(r); }
}

console.log('# an unchanged name is a no-op');
{
  const r = root();
  try {
    writeRecord(r, emptyRecord('same', 'sid-2'));
    const res = reconcile(r, { sessionId: 'sid-2', name: 'same' });
    assertEq(res.renamed, null, 'no rename reported');
    assertEq(res.created, false, 'nothing created');
  } finally { clean(r); }
}

console.log('# stale records are pruned only when the live set is supplied');
{
  const r = root();
  try {
    writeRecord(r, emptyRecord('mine', 'sid-live'));
    writeRecord(r, emptyRecord('ghost', 'sid-dead'));

    // Without a live set, pruning must not be guessed at.
    const noSet = reconcile(r, { sessionId: 'sid-live', name: 'mine' });
    assertEq(noSet.pruned, [], 'no pruning without a live set');
    assert(existsSync(recordPath(r, 'ghost')), 'ghost survives when the live set is unknown');

    const withSet = reconcile(r, { sessionId: 'sid-live', name: 'mine', liveSessionIds: ['sid-live'] });
    assertEq(withSet.pruned, ['ghost'], 'stale record pruned');
    assert(!existsSync(recordPath(r, 'ghost')), 'ghost file removed');
    assert(existsSync(recordPath(r, 'mine')), 'live record untouched');
  } finally { clean(r); }
}

console.log('# concurrent chats do not collide');
{
  const r = root();
  try {
    reconcile(r, { sessionId: 'sid-a', name: 'chat-a' });
    reconcile(r, { sessionId: 'sid-b', name: 'chat-b' });
    const all = listRecords(r).map((x) => x.chat).sort();
    assertEq(all, ['chat-a', 'chat-b'], 'both records coexist, one file each');
  } finally { clean(r); }
}

console.log('# a corrupt record does not throw');
{
  const r = root();
  try {
    mkdirSync(join(r, 'workspace-scratchpad', 'chats'), { recursive: true });
    writeFileSync(recordPath(r, 'broken'), '{ not json');
    assertEq(readRecord(r, 'broken'), null, 'corrupt record reads as null');
    assertEq(listRecords(r), [], 'corrupt record is skipped in listings');
  } finally { clean(r); }
}


console.log('# task lifecycle');
{
  const r = root();
  try {
    reconcile(r, { sessionId: 'sid-t', name: 'worker' });

    const added = addTask(r, 'worker', { workItem: 'gh:1', branch: 'feature/a', repo: 'app' });
    assertEq(added.action, 'added', 'a new task reports action "added"');
    addTask(r, 'worker', { workItem: 'gh:2', branch: 'feature/b', repo: 'app' });
    assertEq(readRecord(r, 'worker').tasks.length, 2, 'two tasks recorded');

    // Re-recording the same work item + repo + branch is idempotent —
    // /start-work is not guaranteed to run exactly once per task.
    const again = addTask(r, 'worker', { workItem: 'gh:1', branch: 'feature/a', repo: 'app' });
    assertEq(again.action, 'unchanged', 're-adding the same triple reports action "unchanged"');
    assertEq(readRecord(r, 'worker').tasks.length, 2, 'no duplicate created');

    // A second branch for the same issue in the same repo is added
    // alongside, never a replacement (gh:206): each branch is its own
    // worktree and its own PR.
    const second = addTask(r, 'worker', { workItem: 'gh:1', branch: 'feature/a-alt', repo: 'app' });
    assertEq(second.action, 'added', 'a second branch for the same issue is added, not a swap');
    assertEq(
      readRecord(r, 'worker').tasks.filter((t) => t.workItem === 'gh:1' && t.repo === 'app').map((t) => t.branch),
      ['feature/a', 'feature/a-alt'],
      'both branches of the issue in the repo are kept',
    );

    // The same issue against two repos is a legitimate multi-repo task.
    addTask(r, 'worker', { workItem: 'gh:1', branch: 'feature/a', repo: 'api' });
    assertEq(readRecord(r, 'worker').tasks.length, 4, 'same issue in a second repo is a separate task');

    // --branch narrows removal to one branch of the item/repo.
    const one = removeTask(r, 'worker', { workItem: 'gh:1', repo: 'app', branch: 'feature/a' });
    assertEq(one.action, 'removed', 'a real removal reports action "removed"');
    assertEq(one.removed, 1, 'one branch removed');
    assert(
      !readRecord(r, 'worker').tasks.some((t) => t.branch === 'feature/a' && t.repo === 'app'),
      'the named branch is gone',
    );
    assert(
      readRecord(r, 'worker').tasks.some((t) => t.workItem === 'gh:1' && t.branch === 'feature/a-alt' && t.repo === 'app'),
      'the other branch of the issue survives',
    );
    assert(
      readRecord(r, 'worker').tasks.some((t) => t.workItem === 'gh:1' && t.repo === 'api'),
      'the other repo\'s task survives',
    );

    // No --branch removes every branch of the item/repo.
    const rest = removeTask(r, 'worker', { workItem: 'gh:1', repo: 'app' });
    assertEq(rest.removed, 1, 'the remaining branch of the item/repo removed');
    assert(
      !readRecord(r, 'worker').tasks.some((t) => t.workItem === 'gh:1' && t.repo === 'app'),
      'nothing of the item/repo remains',
    );
    assertEq(readRecord(r, 'worker').tasks.length, 2, 'gh:2 and the api entry remain');

    const noop = removeTask(r, 'worker', { workItem: 'nope' });
    assertEq(noop.action, 'unchanged', 'removing an absent task reports action "unchanged"');
    assertEq(noop.removed, 0, 'removing an absent task is a no-op');
  } finally { clean(r); }
}

console.log('# remove-all: --work-item with no branch takes every branch across repos');
{
  const r = root();
  try {
    reconcile(r, { sessionId: 'sid-rm', name: 'remover' });
    addTask(r, 'remover', { workItem: 'gh:3', branch: 'feature/one', repo: 'app' });
    addTask(r, 'remover', { workItem: 'gh:3', branch: 'feature/two', repo: 'app' });
    addTask(r, 'remover', { workItem: 'gh:3', branch: 'feature/two', repo: 'api' });
    addTask(r, 'remover', { workItem: 'gh:4', branch: 'feature/other', repo: 'app' });

    // With --repo: every branch of the item in that repo.
    const inRepo = removeTask(r, 'remover', { workItem: 'gh:3', repo: 'app' });
    assertEq(inRepo.action, 'removed', 'removal across branches reports action "removed"');
    assertEq(inRepo.removed, 2, 'both branches in the repo removed at once');
    assertEq(
      readRecord(r, 'remover').tasks.filter((t) => t.workItem === 'gh:3').map((t) => t.repo),
      ['api'],
      'the item\'s entry in the other repo survives',
    );

    // Without --repo: every branch of the item everywhere.
    const everywhere = removeTask(r, 'remover', { workItem: 'gh:3' });
    assertEq(everywhere.removed, 1, 'the last entry of the item removed');
    assert(
      !readRecord(r, 'remover').tasks.some((t) => t.workItem === 'gh:3'),
      'nothing of the item remains',
    );
    assertEq(readRecord(r, 'remover').tasks.length, 1, 'the unrelated task survives');
  } finally { clean(r); }
}

console.log('# tasks without a tracker: workItem null, keyed by branch + repo');
{
  const r = root();
  try {
    reconcile(r, { sessionId: 'sid-n', name: 'nowork' });

    const added = addTask(r, 'nowork', { branch: 'feature/local', repo: 'app' });
    assertEq(added.action, 'added', 'a task with no work item is recorded');
    assertEq(
      readRecord(r, 'nowork').tasks,
      [{ workItem: null, branch: 'feature/local', repo: 'app' }],
      'the entry carries workItem: null',
    );

    // Re-recording the same branch + repo is idempotent, exactly as
    // re-recording a tracked task is — /start-work is not always run exactly
    // once, with or without a tracker.
    const again = addTask(r, 'nowork', { branch: 'feature/local', repo: 'app' });
    assertEq(again.action, 'unchanged', 'identity without a work item is branch + repo');
    assertEq(readRecord(r, 'nowork').tasks.length, 1, 'no duplicate created');
    addTask(r, 'nowork', { branch: 'feature/other', repo: 'app' });
    assertEq(readRecord(r, 'nowork').tasks.length, 2, 'a second branch in the same repo is a separate task');

    // Branch-only removal needs no repo — the branch names the task in any
    // repo — and never touches a tracked entry on the same branch.
    addTask(r, 'nowork', { workItem: 'gh:5', branch: 'feature/other', repo: 'app' });
    const rm = removeTask(r, 'nowork', { branch: 'feature/local' });
    assertEq(rm.action, 'removed', 'remove works without a work item, by branch');
    assertEq(
      readRecord(r, 'nowork').tasks,
      [{ workItem: null, branch: 'feature/other', repo: 'app' }, { workItem: 'gh:5', branch: 'feature/other', repo: 'app' }],
      'only the matching branch removed',
    );
    const guarded = removeTask(r, 'nowork', { branch: 'feature/other' });
    assertEq(guarded.removed, 1, 'the tracker-less entry on the branch is removed');
    assertEq(
      readRecord(r, 'nowork').tasks,
      [{ workItem: 'gh:5', branch: 'feature/other', repo: 'app' }],
      'a tracked entry on the same branch survives a branch-only removal',
    );

    throws(() => removeTask(r, 'nowork', {}), 'removeTask needs a work item or a branch');
  } finally { clean(r); }
}

console.log('# a task may target the workspace repo (repo: ".")');
{
  const r = root();
  try {
    reconcile(r, { sessionId: 'sid-w', name: 'wsworker' });
    addTask(r, 'wsworker', { workItem: 'gh:6', branch: 'feature/ws', repo: '.' });
    assertEq(
      readRecord(r, 'wsworker').tasks,
      [{ workItem: 'gh:6', branch: 'feature/ws', repo: '.' }],
      'repo "." round-trips through the record',
    );
    // Identity is workItem + repo + branch, so the same issue against "." and
    // a project repo are two entries — a multi-repo task including the
    // workspace itself.
    addTask(r, 'wsworker', { workItem: 'gh:6', branch: 'feature/ws', repo: 'app' });
    assertEq(readRecord(r, 'wsworker').tasks.length, 2, '"." and a project repo are distinct targets');
    assertEq(removeTask(r, 'wsworker', { workItem: 'gh:6', repo: '.' }).removed, 1, 'remove targets the "." entry only');
    assert(
      readRecord(r, 'wsworker').tasks.some((t) => t.workItem === 'gh:6' && t.repo === 'app'),
      'the project-repo entry survives',
    );
  } finally { clean(r); }
}

console.log('# scope declaration');
{
  const r = root();
  try {
    reconcile(r, { sessionId: 'sid-s', name: 'scoped' });
    setScope(r, 'scoped', { epic: 'engine', labels: ['llm-quality'], paths: ['src/metrics/**'] });
    const rec = readRecord(r, 'scoped');
    assertEq(rec.scope.epic, 'engine', 'epic recorded');
    assertEq(rec.scope.labels, ['llm-quality'], 'labels recorded');
    assertEq(rec.scope.paths, ['src/metrics/**'], 'paths recorded');
  } finally { clean(r); }
}

console.log('# task ops refuse to invent a record');
{
  const r = root();
  try {
    throws(() => addTask(r, 'ghost', { workItem: 'gh:1', branch: 'b' }), 'addTask on a missing record throws');
    throws(() => removeTask(r, 'ghost', { workItem: 'gh:1' }), 'removeTask on a missing record throws');
    reconcile(r, { sessionId: 'x', name: 'real' });
    throws(() => addTask(r, 'real', { workItem: 'gh:1' }), 'addTask requires a branch');
  } finally { clean(r); }
}

console.log('# resolveChatName: a registry without a name must not rename to the UUID');
{
  const r = root();
  try {
    writeRecord(r, emptyRecord('real-name', 'sid-9'));
    assertEq(resolveChatName(r, { sessionId: 'sid-9', registryName: null }), 'real-name', 'existing record name beats the raw id');
    assertEq(resolveChatName(r, { sessionId: 'sid-9', registryName: 'from-registry' }), 'from-registry', 'registry name beats everything');
    assertEq(resolveChatName(r, { sessionId: 'sid-fresh', registryName: null }), 'sid-fresh', 'a new unnamed chat falls back to its id');
    assertEq(resolveChatName(r, { sessionId: 'sid-fresh', registryName: 'named-anyway' }), 'named-anyway', 'a named new chat uses the name');
  } finally { clean(r); }
}

console.log('# parseArgs validation');
{
  throws(() => parseArgs(['node', 's']), 'a mode is required');
  throws(() => parseArgs(['node', 's', '--reconcile']), '--reconcile needs session-id and name');
  throws(() => parseArgs(['node', 's', '--bogus']), 'unknown flag rejected');
  throws(() => parseArgs(['node', 's', '--add-task', '--chat', 'c']), '--add-task needs a branch');
  throws(() => parseArgs(['node', 's', '--remove-task']), '--remove-task needs chat and a selector');
  throws(() => parseArgs(['node', 's', '--remove-task', '--chat', 'c']), '--remove-task needs work-item or branch');
  const noTracker = parseArgs(['node', 's', '--add-task', '--chat', 'c', '--branch', 'feature/x', '--repo', 'app']);
  assertEq([noTracker.mode, noTracker.chat, noTracker.branch, noTracker.repo, noTracker.workItem],
    ['add-task', 'c', 'feature/x', 'app', null], '--work-item is optional on --add-task');
  const rmBranch = parseArgs(['node', 's', '--remove-task', '--chat', 'c', '--branch', 'feature/x']);
  assertEq([rmBranch.mode, rmBranch.branch], ['remove-task', 'feature/x'], '--remove-task can select by branch alone');
  const ok = parseArgs(['node', 's', '--root', '/tmp/x', '--reconcile', '--session-id', 'i', '--name', 'n']);
  assertEq([ok.root, ok.mode, ok.sessionId, ok.name], ['/tmp/x', 'reconcile', 'i', 'n'], 'valid args parse');
  assertEq(parseArgs(['node', 's', '--root', '/tmp/x', '--whoami']).mode, 'whoami', '--whoami parses as a mode');
  throws(() => parseArgs(['node', 's', '--owner']), '--owner requires a work item');
  const own = parseArgs(['node', 's', '--owner', 'gh:42']);
  assertEq([own.mode, own.workItem], ['owner', 'gh:42'], '--owner parses with its work item');
}

console.log('# whoami resolves this chat\'s record from the session id');
{
  const r = root();
  try {
    writeRecord(r, emptyRecord('alpha', 'sid-live'));
    writeRecord(r, emptyRecord('beta', 'sid-other'));
    assertEq(whoami(r, { env: { CLAUDE_CODE_SESSION_ID: 'sid-live' } }), 'alpha', 'a sessionId match resolves the record name');
    assertEq(whoami(r, { env: { CLAUDE_CODE_SESSION_ID: 'sid-none' } }), null, 'no matching record is null');
    assertEq(whoami(r, { env: {} }), null, 'an unset env var is null, not a guess');
  } finally { clean(r); }
}

console.log('# whoami CLI: bare name on stdout, silence and exit 1 without a match');
{
  const r = root();
  try {
    writeRecord(r, emptyRecord('alpha', 'sid-live'));
    const script = fileURLToPath(new URL('./chat-record.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [script, '--root', r, '--whoami'], {
      encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sid-live' },
    });
    assertEq(out.trim(), 'alpha', 'CLI prints the bare record name');

    let exit = null;
    let silent = '';
    try {
      silent = execFileSync(process.execPath, [script, '--root', r, '--whoami'], {
        encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sid-none' },
      });
    } catch (err) {
      exit = err.status;
      silent = err.stdout;
    }
    assertEq(exit, 1, 'no match exits 1');
    assertEq(String(silent), '', 'no match prints nothing');
  } finally { clean(r); }
}

console.log('# findOwner: the chat a work item\'s tasks belong to (gh:188)');
{
  const r = root();
  try {
    reconcile(r, { sessionId: 'sid-o1', name: 'owner' });
    addTask(r, 'owner', { workItem: 'gh:40', branch: 'feature/shared', repo: 'app' });
    addTask(r, 'owner', { workItem: 'gh:40', branch: 'feature/shared', repo: '.' });
    reconcile(r, { sessionId: 'sid-b', name: 'bystander' });
    addTask(r, 'bystander', { workItem: 'gh:41', branch: 'feature/other', repo: 'app' });

    assertEq(
      findOwner(r, 'gh:40'),
      { chat: 'owner', branches: [{ branch: 'feature/shared', repos: ['app', '.'] }] },
      'the owning chat, its branch, and every repo of that branch',
    );
    assertEq(findOwner(r, 'gh:999'), null, 'an unowned work item is null');
    assertEq(findOwner(r, null), null, 'a missing work item is null');

    // One issue on two branches: the answer carries both, each with its own
    // repos — the first must not hide the second (gh:206).
    addTask(r, 'owner', { workItem: 'gh:42', branch: 'feature/one', repo: 'app' });
    addTask(r, 'owner', { workItem: 'gh:42', branch: 'feature/two', repo: 'app' });
    addTask(r, 'owner', { workItem: 'gh:42', branch: 'feature/two', repo: 'api' });
    assertEq(
      findOwner(r, 'gh:42'),
      { chat: 'owner', branches: [
        { branch: 'feature/one', repos: ['app'] },
        { branch: 'feature/two', repos: ['app', 'api'] },
      ] },
      'every branch of the issue, each with its own repos',
    );

    // A tracker-less task carries workItem null — it is never an owner hit.
    reconcile(r, { sessionId: 'sid-n', name: 'nowork' });
    addTask(r, 'nowork', { branch: 'feature/local', repo: 'app' });
    assertEq(findOwner(r, 'feature/local'), null, 'a branch is not a work item — no false match');
  } finally { clean(r); }
}

console.log('# findOwner: a stray duplicate answers with the most recent record');
{
  const r = root();
  try {
    // An adoption that kept the old entry leaves two records listing the
    // task; the chat that touched its record last is the live owner.
    const older = emptyRecord('older', 'sid-old');
    older.tasks.push({ workItem: 'gh:50', branch: 'feature/dup', repo: 'app' });
    writeRecord(r, older);
    const newer = emptyRecord('newer', 'sid-new');
    newer.tasks.push({ workItem: 'gh:50', branch: 'feature/dup', repo: 'app' });
    writeRecord(r, newer);
    // Force the ordering — write mtimes can tie on coarse filesystems.
    const day = 24 * 60 * 60 * 1000;
    const ago = (d) => new Date(Date.now() - d * day);
    utimesSync(recordPath(r, 'older'), ago(7), ago(7));
    assertEq(findOwner(r, 'gh:50').chat, 'newer', 'the most recently modified record wins');
    utimesSync(recordPath(r, 'newer'), ago(14), ago(14));
    assertEq(findOwner(r, 'gh:50').chat, 'older', 'touching the older record flips the answer');
  } finally { clean(r); }
}

console.log('# --owner CLI: JSON on stdout, silence and exit 1 without an owner');
{
  const r = root();
  try {
    reconcile(r, { sessionId: 'sid-c', name: 'cliowner' });
    addTask(r, 'cliowner', { workItem: 'gh:60', branch: 'feature/cli-owner', repo: 'app' });
    const script = fileURLToPath(new URL('./chat-record.mjs', import.meta.url));
    const out = JSON.parse(execFileSync(process.execPath, [script, '--root', r, '--owner', 'gh:60'], { encoding: 'utf8' }));
    assertEq(
      out,
      { chat: 'cliowner', branches: [{ branch: 'feature/cli-owner', repos: ['app'] }] },
      'CLI prints the owner payload',
    );

    let exit = null;
    let silent = '';
    try {
      silent = execFileSync(process.execPath, [script, '--root', r, '--owner', 'gh:999'], { encoding: 'utf8' });
    } catch (err) {
      exit = err.status;
      silent = err.stdout;
    }
    assertEq(exit, 1, 'no owner exits 1');
    assertEq(String(silent), '', 'no owner prints nothing');
  } finally { clean(r); }
}

console.log('# nothing is written outside the given root (gh:142 regression)');
{
  const r = root();
  const elsewhere = mkdtempSync(join(tmpdir(), 'chat-cwd-'));
  const original = process.cwd();
  try {
    process.chdir(elsewhere);
    reconcile(r, { sessionId: 'sid-z', name: 'zed' });
    assert(existsSync(recordPath(r, 'zed')), 'record written under the given root');
    assertEq(readdirSync(elsewhere), [], 'nothing written into cwd');
  } finally {
    process.chdir(original);
    clean(r); clean(elsewhere);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
