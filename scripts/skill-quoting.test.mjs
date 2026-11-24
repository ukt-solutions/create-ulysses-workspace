#!/usr/bin/env node
// Tests for the quoting convention in the shipped skills (gh:129).
// Run: node scripts/skill-quoting.test.mjs
//
// A skill's shell command line is typed by Claude through the Bash tool with
// each {placeholder} replaced by a real value — often text from the chat: a
// description, a session name, a branch, a commit subject. Inside double
// quotes the shell still expands $(…), backticks and $VAR, so chat text
// would run before the script even starts. The convention is single quotes
// around every placeholder value (a `'` inside the value is written `'\''`),
// and a body of free text goes in through a quoted heredoc, never through
// `echo "…"`.
//
// A placeholder may stay unquoted only when it can never hold free text: an
// identifier, an enum, a number, or a path a script or hook printed. Those
// names are listed in TRUSTED_PLACEHOLDERS below; any other placeholder on a
// shell line must be quoted, so a new placeholder fails closed.
//
// This test reads every markdown file under template/_claude/skills/ and
// checks the code in it: shell fences (bash/sh/shell/zsh) and the inline
// code spans that are shell commands. JSON, JavaScript (including the
// JavaScript inside `node -e '…'`), templates and prose are not shell and
// are skipped. scripts/ is not part of the published package.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(REPO_ROOT, 'template/_claude/skills');

let failed = 0;
let passed = 0;
function check(label, ok, extra = '') {
  if (ok) passed++;
  else { failed++; console.error(`  FAIL: ${label}${extra ? `\n    ${extra}` : ''}`); }
}

function markdownFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...markdownFiles(path));
    else if (path.endsWith('.md')) files.push(path);
  }
  return files;
}

// A placeholder is {name}, {one-line summary}, {group/sub/project}, {a|b}:
// it starts with a letter, so JSON such as {"todos": []} is not one.
const PLACEHOLDER = String.raw`\{[A-Za-z][\w .\/|-]*\}`;
// A double-quoted string holding a placeholder and no shell variable or
// command substitution of its own (`"${session_branch}-*"` is a real shell
// variable and stays double-quoted).
const DOUBLE_QUOTED = new RegExp(String.raw`"[^"$\`\n]*${PLACEHOLDER}[^"$\`\n]*"`, 'g');
const SINGLE_QUOTED = new RegExp(String.raw`'[^'\n]*${PLACEHOLDER}[^'\n]*'`);
// An inline code span is a shell command when it starts like one.
const SHELL_SPAN = /^(?:node|git|gh|glab|cd|npm|npx|cat|echo|ls|grep|--?[a-z][\w-]*)\b/;

// Placeholders that hold a validated identifier (a repo key, the workspace
// user, a commit sha, a run id), an enum, a number, or a path that a script
// or hook printed (the launcher root, a worktree, an update payload). They
// never carry chat text, so an unquoted use is not an injection point.
const TRUSTED_PLACEHOLDERS = new Set([
  'repo', 'user', 'workspace.user', 'sha', 'run_id', 'min',
  'braindump|handoff|research', 'team-member|shared',
  'launcher', 'scripts', 'payload', 'baseline', 'worktree', 'workspace-root', 'project-path',
]);

// A heredoc body is data fed to a command, not shell: blank its lines (the
// opener line stays, and line numbers do not move).
const withoutHeredocBodies = (text) =>
  text.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g,
    (m) => m.split('\n').map((line, i) => (i === 0 ? line : '')).join('\n'));

// Drop single-quoted text — it may span lines (`node -e '…JS…'`), so the
// JavaScript inside is not mistaken for shell.
const withoutSingleQuoted = (text) => text.replace(/'(?:[^'\\]|\\.)*'/g, "''");

const offenders = [];
const unquoted = [];
const echoBodies = [];

for (const file of markdownFiles(SKILLS)) {
  const rel = relative(SKILLS, file);
  const source = readFileSync(file, 'utf8');
  let singleQuotedValues = 0;

  // Check shell text that starts on `firstLine`.
  const scanShell = (rawText, firstLine) => {
    const text = withoutHeredocBodies(rawText);
    withoutSingleQuoted(text).split('\n').forEach((line, n) => {
      for (const m of line.matchAll(DOUBLE_QUOTED)) offenders.push(`${rel}:${firstLine + n}: ${m[0]}`);
      // What is left once quoted text and trailing comments are gone is bare shell.
      const bare = line.replace(DOUBLE_QUOTED, '').replace(/(^|\s)#.*$/, '$1');
      for (const m of bare.matchAll(new RegExp(String.raw`(?<!\$)${PLACEHOLDER}`, 'g'))) {
        if (!TRUSTED_PLACEHOLDERS.has(m[0].slice(1, -1))) unquoted.push(`${rel}:${firstLine + n}: ${m[0]}`);
      }
    });
    for (const line of text.split('\n')) if (SINGLE_QUOTED.test(line)) singleQuotedValues++;
    if (/echo\s+"\$BODY"/.test(rawText)) echoBodies.push(`${rel}:${firstLine}`);
  };

  let fence = null;
  source.split('\n').forEach((line, i) => {
    const marker = line.match(/^\s*```(\w*)/);
    if (marker) {
      if (fence && /^(?:bash|sh|shell|zsh)$/.test(fence.lang)) scanShell(fence.body.join('\n'), fence.start + 1);
      fence = fence ? null : { lang: marker[1], start: i + 1, body: [] };
      return;
    }
    if (fence) { fence.body.push(line); return; }
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      if (SHELL_SPAN.test(span[1])) scanShell(span[1], i + 1);
    }
  });

  // A skill that single-quotes a value says how to write a quote inside one.
  if (singleQuotedValues > 0) {
    check(`${rel}: explains the single-quote convention (a ' inside a value is written '\\'')`,
      source.includes("'\\''"));
  }
}

check('no shell command in a skill double-quotes a {placeholder}', offenders.length === 0,
  `found ${offenders.length}:\n      ${offenders.join('\n      ')}`);
check('no shell command in a skill leaves a chat-text {placeholder} unquoted', unquoted.length === 0,
  `found ${unquoted.length}:\n      ${unquoted.join('\n      ')}`);
check('no skill pipes a body through echo "$BODY"', echoBodies.length === 0,
  `found in: ${echoBodies.join(', ')} — pass the body through a quoted heredoc`);

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
