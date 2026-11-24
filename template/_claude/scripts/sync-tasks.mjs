// Mirror TodoWrite ↔ session.md ## Tasks section.
// Round-trips a flat task list across chats by persisting it on the session branch.

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { fileURLToPath } from 'url';
import { readSessionFile } from '../lib/session-frontmatter.mjs';
import { createTracker } from './trackers/interface.mjs';

// Words ending in "ing" that are not gerunds, so they still take a suffix.
const VERBS_ENDING_ING = new Set([
  'bring', 'sing', 'ring', 'sting', 'swing', 'fling', 'cling', 'spring', 'string', 'wring',
  'ding', 'ping',
]);

// Gerunds the suffix rules in toActiveForm cannot derive, keyed by lowercase verb:
// verbs that change shape (die → dying), take a "k" (panic → panicking), or double
// the final consonant of a multi-syllable word (commit → committing). Add an entry
// when a verb comes out wrong.
const IRREGULARS = {
  be: 'being',
  die: 'dying', lie: 'lying', tie: 'tying',
  panic: 'panicking', mimic: 'mimicking', picnic: 'picnicking', traffic: 'trafficking',
  commit: 'committing', submit: 'submitting', admit: 'admitting', omit: 'omitting',
  permit: 'permitting', debug: 'debugging', begin: 'beginning', forget: 'forgetting',
  regret: 'regretting', refer: 'referring', prefer: 'preferring', occur: 'occurring',
  control: 'controlling', patrol: 'patrolling', compel: 'compelling', expel: 'expelling',
  propel: 'propelling', equip: 'equipping', upset: 'upsetting', unzip: 'unzipping',
  format: 'formatting', reset: 'resetting', rerun: 'rerunning', quit: 'quitting',
};

// Derives the TodoWrite activeForm for a task from its content, which is all the
// ## Tasks format keeps. The label is cosmetic, so anything that is not clearly a
// verb comes back verbatim rather than mangled. Rules, in order:
//   1. first token not a plain word (Phase:, v0.24, gh:115) → content as-is
//   2. first token already a gerund (Running, Testing) → content as-is
//   3. IRREGULARS lookup, keeping the first letter's case
//   4. trailing "e" → drop it (write → writing), except ee/oe/ye (see → seeing)
//   5. one-syllable consonant-vowel-consonant → double it (run → running);
//      w, x and y never double (show → showing)
//   6. otherwise append "ing" (open → opening, identify → identifying)
export function toActiveForm(content) {
  const trimmed = content.trim();
  if (!trimmed) return '';
  const firstSpace = trimmed.search(/\s/);
  const verb = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace);

  if (!/^[A-Za-z]+$/.test(verb)) return trimmed;

  const lower = verb.toLowerCase();
  if (lower.length >= 5 && lower.endsWith('ing') && !VERBS_ENDING_ING.has(lower)) {
    return trimmed;
  }

  if (Object.hasOwn(IRREGULARS, lower)) {
    const gerund = IRREGULARS[lower];
    const cased = verb[0] === verb[0].toUpperCase()
      ? gerund[0].toUpperCase() + gerund.slice(1)
      : gerund;
    return cased + rest;
  }

  let gerund;
  if (/(?:ee|oe|ye)$/.test(lower)) {
    gerund = verb + 'ing';
  } else if (lower.endsWith('e')) {
    gerund = verb.slice(0, -1) + 'ing';
  } else if (
    (lower.match(/[aeiou]+/g) || []).length === 1 &&
    /[^aeiou][aeiou][^aeiouwxy]$/.test(lower)
  ) {
    gerund = verb + verb[verb.length - 1] + 'ing';
  } else {
    gerund = verb + 'ing';
  }

  return gerund + rest;
}

const TASKS_HEADING = '## Tasks';
const LINK_PREFIX = '> Linked:';

export function parseTasksSection(sessionMdContent) {
  const lines = sessionMdContent.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === TASKS_HEADING);
  if (startIdx === -1) return { linked: null, todos: [] };

  // Section runs until the next "## " heading or EOF.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break; }
  }

  const sectionLines = lines.slice(startIdx + 1, endIdx);
  let linked = null;
  const todos = [];

  for (const line of sectionLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith(LINK_PREFIX)) {
      const rest = trimmed.slice(LINK_PREFIX.length).trim();
      const dashIdx = rest.indexOf(' — ');
      if (dashIdx === -1) {
        linked = { id: rest, title: null };
      } else {
        linked = { id: rest.slice(0, dashIdx).trim(), title: rest.slice(dashIdx + 3).trim() };
      }
      continue;
    }

    const checkboxMatch = trimmed.match(/^- \[([ x\-])\] (.+)$/);
    if (checkboxMatch) {
      const marker = checkboxMatch[1];
      const status = marker === 'x' ? 'completed' : marker === '-' ? 'in_progress' : 'pending';
      const content = checkboxMatch[2].trim();
      todos.push({ content, activeForm: toActiveForm(content), status });
    }
  }

  return { linked, todos };
}

const START_BOOKEND = { content: 'Start work', activeForm: 'Starting work', status: 'completed' };
const END_BOOKEND   = { content: 'Complete work', activeForm: 'Completing work', status: 'pending' };

export function enforceBookends(todos) {
  const middle = [];
  let foundStart = null;
  let foundEnd = null;
  for (const t of todos) {
    if (t.content === 'Start work') foundStart = t;
    else if (t.content === 'Complete work') foundEnd = t;
    else middle.push(t);
  }
  return [
    foundStart || { ...START_BOOKEND },
    ...middle,
    foundEnd || { ...END_BOOKEND },
  ];
}

export function renderTasksSection({ linked, todos }) {
  const safe = enforceBookends(todos);
  const lines = ['## Tasks', ''];
  if (linked) {
    if (linked.title) {
      lines.push(`> Linked: ${linked.id} — ${linked.title}`);
    } else {
      lines.push(`> Linked: ${linked.id}`);
    }
    lines.push('');
  }
  for (const t of safe) {
    const box = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[-]' : '[ ]';
    lines.push(`- ${box} ${t.content}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeTasksToSession(filePath, taskState) {
  const original = readFileSync(filePath, 'utf-8');
  const newSection = renderTasksSection(taskState);
  const updated = spliceTasksSection(original, newSection);

  // Atomic write: temp file in same dir + rename.
  const tmp = filePath + '.tmp-sync-tasks';
  writeFileSync(tmp, updated);
  renameSync(tmp, filePath);
}

function spliceTasksSection(content, newSection) {
  const lines = content.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === '## Tasks');

  if (startIdx === -1) {
    // Insert before ## Progress if present, else append before EOF.
    const progressIdx = lines.findIndex(l => l.trim() === '## Progress');
    if (progressIdx !== -1) {
      const before = lines.slice(0, progressIdx).join('\n').replace(/\n+$/, '\n');
      const after = lines.slice(progressIdx).join('\n');
      return before + '\n' + newSection + '\n' + after;
    }
    // No Progress section — append at end.
    return content.replace(/\n*$/, '\n\n') + newSection;
  }

  // Find end of existing ## Tasks section (next ## heading or EOF).
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break; }
  }

  const before = lines.slice(0, startIdx).join('\n');
  const after = endIdx < lines.length ? lines.slice(endIdx).join('\n') : '';
  const beforeTrimmed = before.replace(/\n+$/, '\n');
  return beforeTrimmed + '\n' + newSection + (after ? '\n' + after : '');
}

export async function resolveLinked(filePath, { tracker } = {}) {
  const { fields } = readSessionFile(filePath);
  if (!fields.workItem) return null;
  const id = fields.workItem;
  if (!tracker) return { id, title: null };
  try {
    const issue = await tracker.getIssue(id);
    return { id, title: issue?.title || null };
  } catch {
    return { id, title: null };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const filePath = args[1];

  if (!mode || !filePath || (mode !== '--read' && mode !== '--write')) {
    console.error('Usage: sync-tasks.mjs --read|--write <session.md>');
    process.exit(2);
  }

  let fields;
  try {
    fields = readSessionFile(filePath).fields;
  } catch (e) {
    console.error(`Not a session file: ${e.message}`);
    process.exit(2);
  }
  if (fields.type !== 'session-tracker') {
    console.error(`Not a session-tracker file (type=${fields.type})`);
    process.exit(2);
  }

  let tracker = null;
  try {
    const ws = JSON.parse(readFileSync('workspace.json', 'utf-8'));
    if (ws.workspace?.tracker) tracker = createTracker(ws.workspace.tracker);
  } catch {
    // No workspace.json or no tracker configured — skip.
  }

  if (mode === '--read') {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseTasksSection(content);
    if (!parsed.linked) {
      parsed.linked = await resolveLinked(filePath, { tracker });
    }
    process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    return;
  }

  const stdin = await readStdin();
  const input = JSON.parse(stdin);
  const linked = input.linked ?? await resolveLinked(filePath, { tracker });
  writeTasksToSession(filePath, { linked, todos: input.todos || [] });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
