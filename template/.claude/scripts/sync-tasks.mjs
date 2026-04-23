// Mirror TodoWrite ↔ session.md ## Tasks section.
// Round-trips a flat task list across chats by persisting it on the session branch.

const IRREGULARS = {
  // Pre-built map for verbs whose gerund isn't a clean suffix transform.
  // Add entries as needed; the rule of thumb is "if the test catches it, fix here".
};

export function toActiveForm(content) {
  const trimmed = content.trim();
  const firstSpace = trimmed.indexOf(' ');
  const verb = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace);

  const lower = verb.toLowerCase();
  if (IRREGULARS[lower]) return IRREGULARS[lower] + rest;

  let gerund;
  if (verb.endsWith('e') && !verb.endsWith('ee')) {
    gerund = verb.slice(0, -1) + 'ing';
  } else if (
    verb.length >= 3 &&
    /[aeiou]/.test(verb[verb.length - 2]) &&
    !/[aeiouwxy]/.test(verb[verb.length - 1])
  ) {
    // CVC pattern → double the final consonant (Run → Running)
    // Skip when ending in w/x/y (Show → Showing, Fix → Fixing).
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

    const checkboxMatch = trimmed.match(/^- \[([ x])\] (.+)$/);
    if (checkboxMatch) {
      const status = checkboxMatch[1] === 'x' ? 'completed' : 'pending';
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
    const box = t.status === 'completed' ? '[x]' : '[ ]';
    lines.push(`- ${box} ${t.content}`);
  }
  lines.push('');
  return lines.join('\n');
}
