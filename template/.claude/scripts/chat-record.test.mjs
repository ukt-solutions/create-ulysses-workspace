#!/usr/bin/env node
// Tests for chat-record.mjs
// Run: node .claude/scripts/chat-record.test.mjs
//
// Every case builds its own fixture under tmpdir. Nothing reads the real
// workspace or the real session registry.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordPath, drawerPath, emptyRecord, readRecord, writeRecord,
  listRecords, reconcile, parseArgs,
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

console.log('# parseArgs validation');
{
  throws(() => parseArgs(['node', 's']), 'a mode is required');
  throws(() => parseArgs(['node', 's', '--reconcile']), '--reconcile needs session-id and name');
  throws(() => parseArgs(['node', 's', '--bogus']), 'unknown flag rejected');
  const ok = parseArgs(['node', 's', '--root', '/tmp/x', '--reconcile', '--session-id', 'i', '--name', 'n']);
  assertEq([ok.root, ok.mode, ok.sessionId, ok.name], ['/tmp/x', 'reconcile', 'i', 'n'], 'valid args parse');
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
