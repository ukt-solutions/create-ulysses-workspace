#!/usr/bin/env node
// The chat record: one file per long-lived chat, holding what that chat owns.
//
// The framework assumed one task spanning many chats and built a folder and a
// tracker file around it. Practice is one chat spanning many tasks (gh:132).
// The durable per-chat state is small — a declared scope, the concerns it
// subscribes to, and the tasks currently open under it — and it is
// machine-local, because chats are.
//
// Keyed on sessionId, filed under the chat name. Claude Code lets a session be
// renamed at any time, so a record keyed only by name is orphaned by a rename
// and a record keyed only by id is unreadable. The session registry carries
// both, so the record carries both: the filename stays legible, and
// reconcile() renames it when the chat's name changes.
//
// Lives in workspace-scratchpad/ because it is machine-local and regenerable —
// losing it costs one re-declaration of scope, not the work.
//
// Usage:
//   node chat-record.mjs --root <dir> --list
//   node chat-record.mjs --root <dir> --read  <chat-name>
//   node chat-record.mjs --root <dir> --reconcile --session-id <id> --name <n>

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, renameSync, rmSync, realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const CHATS_DIR = join('workspace-scratchpad', 'chats');

function chatsDir(root) {
  return join(resolve(root), CHATS_DIR);
}

function recordPath(root, chatName) {
  return join(chatsDir(root), `${chatName}.json`);
}

// The chat drawer: in-progress designs, braindumps and research that should not
// reach other chats until promoted. This is why local-only-* piles up at
// workspace roots today — capture skills invoked from the launcher have nowhere
// chat-scoped to write.
function drawerPath(root, chatName) {
  return join(chatsDir(root), chatName);
}

function emptyRecord(chatName, sessionId) {
  return {
    chat: chatName,
    sessionId,
    scope: { epic: null, labels: [], paths: [] },
    concerns: [],
    tasks: [],
  };
}

function readRecord(root, chatName) {
  const p = recordPath(root, chatName);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    // A corrupt record is machine-local and regenerable. Refusing to start a
    // session over it would be worse than losing a scope declaration.
    return null;
  }
}

function writeRecord(root, record) {
  if (!record || !record.chat) throw new Error('writeRecord: record.chat is required');
  const dir = chatsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(recordPath(root, record.chat), `${JSON.stringify(record, null, 2)}\n`);
  return recordPath(root, record.chat);
}

function listRecords(root) {
  const dir = chatsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => readRecord(root, n.slice(0, -5)))
    .filter(Boolean);
}

/**
 * Bring the records on disk into line with the live session.
 *
 * - A record whose `sessionId` matches but whose filename does not is renamed:
 *   the chat was renamed, and the state follows it.
 * - A record with no matching live session is stale. When `liveSessionIds` is
 *   supplied it is pruned; when it is not, pruning is skipped entirely rather
 *   than guessed at — deleting state on incomplete information is worse than
 *   leaving it.
 */
function reconcile(root, { sessionId, name, liveSessionIds = null } = {}) {
  if (!sessionId || !name) throw new Error('reconcile: sessionId and name are required');
  const result = { renamed: null, created: false, pruned: [] };

  const existing = listRecords(root);
  const mine = existing.find((r) => r.sessionId === sessionId);

  if (mine && mine.chat !== name) {
    const oldName = mine.chat;
    const from = recordPath(root, oldName);
    const to = recordPath(root, name);

    mine.chat = name;
    writeRecord(root, mine);
    if (existsSync(from) && from !== to) rmSync(from);

    // The drawer travels with the record. A rename that leaves captures behind
    // under the old name strands them somewhere nothing looks.
    const drawerFrom = drawerPath(root, oldName);
    const drawerTo = drawerPath(root, name);
    if (existsSync(drawerFrom) && !existsSync(drawerTo)) renameSync(drawerFrom, drawerTo);

    result.renamed = { from: oldName, to: name };
  } else if (!mine) {
    writeRecord(root, emptyRecord(name, sessionId));
    result.created = true;
  }

  if (Array.isArray(liveSessionIds)) {
    for (const r of listRecords(root)) {
      if (r.sessionId === sessionId) continue;
      if (!liveSessionIds.includes(r.sessionId)) {
        rmSync(recordPath(root, r.chat), { force: true });
        result.pruned.push(r.chat);
      }
    }
  }
  return result;
}

function parseArgs(argv) {
  const args = { root: '.', mode: null, chat: null, sessionId: null, name: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--root') { args.root = rest[++i]; continue; }
    if (a === '--list') { args.mode = 'list'; continue; }
    if (a === '--read') { args.mode = 'read'; args.chat = rest[++i]; continue; }
    if (a === '--reconcile') { args.mode = 'reconcile'; continue; }
    if (a === '--session-id') { args.sessionId = rest[++i]; continue; }
    if (a === '--name') { args.name = rest[++i]; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  if (!args.mode) throw new Error('one of --list, --read <chat>, --reconcile is required');
  if (args.mode === 'reconcile' && (!args.sessionId || !args.name)) {
    throw new Error('--reconcile requires --session-id and --name');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  let out;
  if (args.mode === 'list') out = listRecords(args.root);
  else if (args.mode === 'read') out = readRecord(args.root, args.chat);
  else out = reconcile(args.root, { sessionId: args.sessionId, name: args.name });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`chat-record: ${err.message}\n`);
    process.exit(2);
  }
}

export {
  recordPath, drawerPath, emptyRecord, readRecord, writeRecord,
  listRecords, reconcile, parseArgs, CHATS_DIR,
};
