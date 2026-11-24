// The scanner behind the tarball audit's shell-exec check (gh:129).
//
// Shipped code never builds a command line for a shell. execSync and exec
// run their string through a shell, so any interpolated value — a branch
// name, session name, path, remote — becomes shell text. Shipped scripts
// call execFileSync/spawnSync with an argument array instead. The scanner
// reads the non-test .mjs files under template/, lib/ and bin/ and reports:
//
//   - any call to execSync(), and any import, re-export or destructure of
//     exec or execSync from child_process;
//   - child_process reached without a static import (require(), import(),
//     process.getBuiltinModule()), because a static import is what lets the
//     checks below see which bindings exist;
//   - in a file that imports child_process, exec or execSync reached through
//     the default or namespace alias (cp.exec, cp.execSync, cp['execSync'],
//     promisify(cp.exec)) — member access on an identifier bound to the
//     import, so RegExp.prototype.exec (re.exec(line)) never counts;
//   - in a file that imports child_process, a string literal naming a shell
//     ('sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'pwsh', with or
//     without a directory) — spawning a shell binary is a shell command by
//     another route;
//   - any `shell:` option whose value is not literally false. The one
//     reviewed exception is npm on Windows, where spawnSync cannot run
//     npm.cmd without a shell: its line carries an `audit:allow-shell`
//     comment naming why the arguments are safe, and the marker exempts only
//     the line that carries it.
//
// Comments are stripped before scanning, so prose mentioning execSync( does
// not fail the audit; strings, template literals and regex literals are
// respected, so a URL in a string is not mistaken for a comment.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const isIdentChar = (c) => /[\w$\u0080-￿]/.test(c);

// A `/` opens a regex literal after an operator, a punctuator, a keyword
// like `return`, or at the start of the file; after a value (an identifier,
// a number, a closing bracket or a string) it divides.
function startsRegex(prev, word) {
  if (prev === '') return true;
  if (prev === 'w') return KEYWORDS_BEFORE_REGEX.has(word);
  return !')]"\'`'.includes(prev);
}

// One pass over the source. `text` is the source with every comment blanked
// to spaces (newlines kept, so offsets and line numbers match the source);
// `strings` lists the string literals that have no ${} part; `ok` is false
// when the source ends inside a string, template, regex or comment — the
// scan cannot vouch for such a file.
function tokenize(src) {
  const n = src.length;
  const out = [];
  const strings = [];
  let i = 0;
  let ok = true;

  const blank = (s) => s.replace(/[^\n]/g, ' ');

  function readString(quote) {
    const start = i;
    let j = i + 1;
    while (j < n && src[j] !== quote && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    if (j >= n || src[j] !== quote) {
      ok = false;
      j = Math.min(j, n);
      out.push(src.slice(i, j));
      i = j;
      return;
    }
    out.push(src.slice(i, j + 1));
    strings.push({ index: start, value: src.slice(start + 1, j) });
    i = j + 1;
  }

  function readTemplate() {
    const start = i;
    let hasExpr = false;
    let raw = '';
    out.push('`');
    i++;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        out.push(src.slice(i, i + 2));
        raw += src.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        out.push(c);
        i++;
        if (!hasExpr) strings.push({ index: start, value: raw });
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        hasExpr = true;
        out.push('${');
        i += 2;
        scanCode(true);
      } else {
        out.push(c);
        raw += c;
        i++;
      }
    }
    ok = false;
  }

  // Reads a regex literal at src[i]; false (nothing consumed) when no
  // closing slash follows on the line, so the slash was a division.
  function readRegex() {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\n') return false;
      if (c === '\\') { j += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        out.push(src.slice(i, j));
        i = j;
        return true;
      }
      j++;
    }
    return false;
  }

  // Scans code. Inside a template's ${…} it stops after the matching `}`.
  function scanCode(inExpr) {
    let depth = 0;
    let prev = '';
    let word = '';
    const setPrev = (p, w = '') => { prev = p; word = w; };
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        let j = src.indexOf('\n', i);
        if (j === -1) j = n;
        out.push(blank(src.slice(i, j)));
        i = j;
      } else if (c === '/' && d === '*') {
        let j = src.indexOf('*/', i + 2);
        if (j === -1) { ok = false; j = n; } else j += 2;
        out.push(blank(src.slice(i, j)));
        i = j;
      } else if (c === '"' || c === "'") {
        readString(c);
        setPrev(c);
      } else if (c === '`') {
        readTemplate();
        setPrev('`');
      } else if (c === '/') {
        if (startsRegex(prev, word) && readRegex()) {
          setPrev(')');
        } else {
          out.push(c);
          i++;
          setPrev(c);
        }
      } else if (c === '{') {
        depth++;
        out.push(c);
        i++;
        setPrev(c);
      } else if (c === '}') {
        out.push(c);
        i++;
        if (inExpr && depth === 0) return;
        depth--;
        setPrev(c);
      } else if (/\s/.test(c)) {
        out.push(c);
        i++;
      } else if (isIdentChar(c)) {
        let j = i;
        while (j < n && isIdentChar(src[j])) j++;
        word = src.slice(i, j);
        out.push(word);
        i = j;
        prev = 'w';
      } else {
        out.push(c);
        i++;
        setPrev(c);
      }
    }
    if (inExpr) ok = false;
  }

  if (src.startsWith('#!')) {
    const j = src.indexOf('\n');
    const end = j === -1 ? n : j;
    out.push(blank(src.slice(0, end)));
    i = end;
  }
  scanCode(false);
  return { text: out.join(''), strings, ok };
}

// The source with comments blanked out; offsets, newlines and every string,
// template and regex literal are untouched.
export function stripComments(src) {
  return tokenize(src).text;
}

const CP_SOURCE = String.raw`['"\`](?:node:)?child_process['"\`]`;
// import / export … from 'child_process'
const FROM_CP = new RegExp(String.raw`\b(import|export)\s*([^;'"\`]*?)\s*from\s*${CP_SOURCE}`, 'g');
// import 'child_process'
const BARE_IMPORT_CP = new RegExp(String.raw`\bimport\s*${CP_SOURCE}`, 'g');
// require('child_process'), import('child_process'), process.getBuiltinModule(…)
const DYNAMIC_CP = new RegExp(String.raw`\b(?:require|import|getBuiltinModule)\s*\(\s*${CP_SOURCE}\s*\)`, 'g');
const SHELL_NAME = /^(?:(?:[A-Za-z]:)?[\\/](?:.*[\\/])?)?(?:sh|bash|zsh|cmd|powershell|pwsh)(?:\.exe)?$/i;
const SHELL_KEY = /(?<![\w$.])(?:(['"`])shell\1|shell)\s*:(?!:)(?!\s*false\b)/g;
const SHELL_ASSIGN = /\.shell\s*=(?!=)(?!\s*false\b)/g;
const DESTRUCTURE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
const ALLOW_MARKER = 'audit:allow-shell';
const SHELL_COMMANDS = ['exec', 'execSync'];
const USE_ARGV = 'use execFileSync/spawnSync with an argument array';

// What an import clause binds: the named imports (as exported, before any
// `as`) and the default or namespace aliases.
function parseClause(clause) {
  const named = [];
  const aliases = [];
  const braces = clause.match(/\{([^}]*)\}/);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) named.push(name);
    }
  }
  const rest = clause.replace(/\{[^}]*\}/, '');
  const ns = rest.match(/\*\s*as\s+([\w$]+)/);
  if (ns) aliases.push(ns[1]);
  const def = rest.replace(/\*\s*as\s+[\w$]+/, '').replace(/,/g, '').trim();
  if (/^[\w$]+$/.test(def)) aliases.push(def);
  return { named, aliases };
}

const lineAt = (src, index) => src.slice(0, index).split('\n').length;
const lineText = (src, index) => {
  const start = src.lastIndexOf('\n', index - 1) + 1;
  const end = src.indexOf('\n', index);
  return src.slice(start, end === -1 ? src.length : end);
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The shell-exec violations in one source file, as
// [{ kind: 'shell-exec', details: 'path:line: message' }].
export function scanShellExec(path, source) {
  const { text, strings, ok } = tokenize(source);
  const found = [];
  const flag = (index, message) => found.push({ index, message });
  let importsChildProcess = false;
  const aliases = [];

  for (const m of text.matchAll(/\bexecSync\s*\(/g)) {
    flag(m.index, `execSync builds a shell command — ${USE_ARGV}`);
  }

  for (const m of text.matchAll(FROM_CP)) {
    importsChildProcess = true;
    const { named, aliases: bound } = parseClause(m[2]);
    aliases.push(...bound);
    for (const name of SHELL_COMMANDS) {
      if (named.includes(name)) flag(m.index, `${m[1]}s ${name}, which runs a shell command — ${USE_ARGV}`);
    }
  }
  if (text.search(BARE_IMPORT_CP) !== -1) importsChildProcess = true;

  for (const m of text.matchAll(DYNAMIC_CP)) {
    importsChildProcess = true;
    flag(m.index, 'loads child_process without a static import, so this check cannot see how it is used — import it at the top of the file');
  }

  if (importsChildProcess) {
    for (const alias of aliases) {
      const a = escapeRe(alias);
      const member = new RegExp(
        String.raw`(?<![\w$.])${a}\s*(?:\?\.|\.)\s*(exec|execSync)\b|(?<![\w$.])${a}\s*(?:\?\.)?\s*\[\s*['"\`](exec|execSync)['"\`]\s*\]`,
        'g',
      );
      for (const m of text.matchAll(member)) {
        flag(m.index, `${alias}.${m[1] || m[2]} runs a shell command — ${USE_ARGV}`);
      }
    }

    for (const m of text.matchAll(DESTRUCTURE)) {
      for (const part of m[1].split(',')) {
        const key = part.split(/[:=]/)[0].trim();
        if (SHELL_COMMANDS.includes(key)) flag(m.index, `destructures ${key}, which runs a shell command — ${USE_ARGV}`);
      }
    }

    for (const s of strings) {
      if (SHELL_NAME.test(s.value)) {
        flag(s.index, `the string ${JSON.stringify(s.value)} names a shell — spawn the program directly with an argument array`);
      }
    }
  }

  for (const re of [SHELL_KEY, SHELL_ASSIGN]) {
    for (const m of text.matchAll(re)) {
      if (lineText(source, m.index).includes(ALLOW_MARKER)) continue;
      flag(m.index, `shell option is not literally false, so the command runs through a shell — ${USE_ARGV}, or mark a reviewed exception with // ${ALLOW_MARKER}`);
    }
  }

  if (!ok) {
    flag(0, 'could not scan this file (an unterminated string, template, regex or comment) — the shell-exec check cannot vouch for it');
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index, message }) => ({ kind: 'shell-exec', details: `${path}:${lineAt(source, index)}: ${message}` }));
}

// The files the check covers: non-test .mjs under template/, lib/ and bin/.
export function isShippedSource(path) {
  return /^(?:template|lib|bin)\//.test(path) && path.endsWith('.mjs') && !path.endsWith('.test.mjs');
}

// Scans each of `files` ([{ path }], relative to `root`) that the check covers.
export function scanShellExecFiles(files, root) {
  const violations = [];
  for (const file of files) {
    if (!isShippedSource(file.path)) continue;
    let source;
    try {
      source = readFileSync(join(root, file.path), 'utf8');
    } catch {
      continue; // Symlink, missing, or unreadable — skip rather than crash.
    }
    violations.push(...scanShellExec(file.path, source));
  }
  return violations;
}
