// Session frontmatter parser for work-sessions/{name}/session.md trackers.
//
// Reads and writes a small, opinionated subset of YAML scoped to the
// fields the workspace actually uses. Lossless rewrites: when a field is
// updated, only that field's lines are touched — every other byte of the
// frontmatter and body is preserved.
//
// Supported value shapes:
//   - flat scalars (string, number, null, boolean, ISO timestamps, UUIDs)
//   - flat lists ("repos:\n  - one\n  - two")
//   - lists of mappings ("chatSessions:\n  - id: x\n    names: [a, b]\n    ...")
//   - inline lists ("names: [a, b]")
//
// Anything outside this subset throws. The parser is intentionally narrow.

import { readFileSync, writeFileSync } from 'fs';

const FM_DELIM = '---';

export function readSessionFile(filePath) {
  return parseSessionContent(readFileSync(filePath, 'utf-8'));
}

export function parseSessionContent(content) {
  const lines = content.split('\n');
  if (lines[0] !== FM_DELIM) {
    throw new Error('No frontmatter found (file does not start with ---)');
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FM_DELIM) { endIdx = i; break; }
  }
  if (endIdx === -1) {
    throw new Error('No closing --- for frontmatter');
  }
  const fmLines = lines.slice(1, endIdx);
  const bodyLines = lines.slice(endIdx + 1);
  const body = bodyLines.join('\n');
  const { fields, fieldRanges } = parseFmLines(fmLines);
  return { fields, body, raw: { fmLines, fieldRanges } };
}

function parseFmLines(fmLines) {
  const fields = {};
  const fieldRanges = {};
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    if (!line.trim() || line.startsWith('#')) { i++; continue; }
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const valuePart = m[2];
    const start = i;

    if (valuePart === '') {
      // Block: either flat list, list of mappings, or empty scalar
      i++;
      const items = [];
      while (i < fmLines.length) {
        const next = fmLines[i];
        if (next.startsWith('  - ')) {
          const itemFirstLine = next.slice(4);
          const mapMatch = itemFirstLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
          if (mapMatch) {
            const item = {};
            item[mapMatch[1]] = parseScalar(mapMatch[2]);
            i++;
            while (i < fmLines.length && fmLines[i].startsWith('    ')) {
              const subLine = fmLines[i].slice(4);
              const subMatch = subLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
              if (subMatch) item[subMatch[1]] = parseScalar(subMatch[2]);
              i++;
            }
            items.push(item);
          } else {
            items.push(parseScalar(itemFirstLine));
            i++;
          }
        } else {
          break;
        }
      }
      if (items.length === 0) {
        fields[key] = null;
        fieldRanges[key] = { start, end: start };
      } else {
        fields[key] = items;
        fieldRanges[key] = { start, end: i - 1 };
      }
    } else {
      fields[key] = parseScalar(valuePart);
      fieldRanges[key] = { start, end: start };
      i++;
    }
  }
  return { fields, fieldRanges };
}

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || /^null$/i.test(s)) return null;
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(p => parseScalar(p.trim()));
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function serializeFieldLines(key, value) {
  if (value === null || value === undefined) return [`${key}: null`];
  if (typeof value === 'boolean' || typeof value === 'number') return [`${key}: ${value}`];
  if (typeof value === 'string') {
    if (needsQuoting(value)) return [`${key}: "${escapeQuoted(value)}"`];
    return [`${key}: ${value}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`];
    if (value.every(v => typeof v !== 'object' || v === null)) {
      return [`${key}:`, ...value.map(v => `  - ${serializeInlineScalar(v)}`)];
    }
    const lines = [`${key}:`];
    for (const item of value) {
      let firstKey = true;
      for (const [k, v] of Object.entries(item)) {
        if (firstKey) {
          lines.push(`  - ${k}: ${serializeMappingValue(v)}`);
          firstKey = false;
        } else {
          lines.push(`    ${k}: ${serializeMappingValue(v)}`);
        }
      }
    }
    return lines;
  }
  throw new Error(`Cannot serialize ${typeof value} as field ${key}`);
}

function serializeMappingValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    return '[' + v.map(serializeInlineScalar).join(', ') + ']';
  }
  if (typeof v === 'string') {
    if (needsQuoting(v)) return `"${escapeQuoted(v)}"`;
    return v;
  }
  throw new Error(`Cannot serialize mapping value of type ${typeof v}`);
}

function serializeInlineScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (needsInlineQuoting(v)) return `"${escapeQuoted(v)}"`;
    return v;
  }
  throw new Error(`Cannot inline-serialize ${typeof v}`);
}

function needsQuoting(s) {
  if (s === '') return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (/^[\[\]{}!&*>|'"`@%?,]/.test(s)) return true;
  if (s === '-' || s.startsWith('- ')) return true;
  if (s.includes(': ')) return true;
  if (s.endsWith(':')) return true;
  if (s.includes(' #')) return true;
  if (s !== s.trim()) return true;
  return false;
}

function needsInlineQuoting(s) {
  if (needsQuoting(s)) return true;
  // Inside [a, b], commas would split the value
  if (s.includes(',')) return true;
  if (s.includes(']')) return true;
  if (s.includes('[')) return true;
  return false;
}

function escapeQuoted(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// === Public write API ===

/**
 * Update specific fields in a session file's frontmatter.
 * Lossless for unchanged fields and the body. Fields set to `undefined`
 * are removed. Fields not present in the file are appended.
 */
export function updateSessionFile(filePath, updates) {
  const content = readFileSync(filePath, 'utf-8');
  const newContent = updateSessionContent(content, updates);
  if (newContent !== content) writeFileSync(filePath, newContent);
}

export function updateSessionContent(content, updates) {
  const parsed = parseSessionContent(content);
  const { fmLines, fieldRanges } = parsed.raw;
  let newFmLines = [...fmLines];

  // Process replacements/removals from bottom to top so line indices stay valid
  const replacements = [];
  const appends = [];
  for (const [key, value] of Object.entries(updates)) {
    if (fieldRanges[key]) {
      replacements.push({ range: fieldRanges[key], key, value });
    } else if (value !== undefined) {
      appends.push({ key, value });
    }
  }
  replacements.sort((a, b) => b.range.start - a.range.start);
  for (const op of replacements) {
    const removeCount = op.range.end - op.range.start + 1;
    if (op.value === undefined) {
      newFmLines.splice(op.range.start, removeCount);
    } else {
      const newLines = serializeFieldLines(op.key, op.value);
      newFmLines.splice(op.range.start, removeCount, ...newLines);
    }
  }
  for (const op of appends) {
    newFmLines.push(...serializeFieldLines(op.key, op.value));
  }

  const reconstructed = ['---', ...newFmLines, '---'];
  if (parsed.body === '') {
    reconstructed.push('');
  } else {
    reconstructed.push(parsed.body);
  }
  return reconstructed.join('\n');
}

/**
 * Create a session file from scratch with the given fields and body.
 * Field order follows the order of keys in the fields object.
 */
export function writeSessionFile(filePath, fields, body = '') {
  const fmLines = [];
  for (const [key, value] of Object.entries(fields)) {
    fmLines.push(...serializeFieldLines(key, value));
  }
  const lines = ['---', ...fmLines, '---', '', body];
  writeFileSync(filePath, lines.join('\n'));
}

/**
 * Convenience: read just the parsed fields object.
 */
export function readSessionFields(filePath) {
  return readSessionFile(filePath).fields;
}
