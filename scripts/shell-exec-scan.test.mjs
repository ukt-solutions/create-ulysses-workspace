#!/usr/bin/env node
// Tests for shell-exec-scan.mjs — the scanner behind the tarball audit's
// shell-exec check.
// Run: node scripts/shell-exec-scan.test.mjs
//
// Every bypass pattern the check must catch has a probe source below; each
// probe is run through the same scanner the audit uses and must produce a
// violation. The clean sources must produce none, and the last block scans
// the code this repo actually ships. The probes live only in this test —
// scripts/ is not part of the published package.

import { scanShellExec, scanShellExecFiles, stripComments } from './shell-exec-scan.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
let passed = 0;
function check(label, ok, extra = '') {
  if (ok) passed++;
  else { failed++; console.error(`  FAIL: ${label}${extra ? `\n    ${extra}` : ''}`); }
}

const scan = (source) => scanShellExec('template/_claude/scripts/probe.mjs', source);
const CP = "import { spawnSync } from 'child_process';\n";

// Each probe is a whole file that must fail the check, with a pattern the
// reported message must match.
const bypasses = [
  // (a) any `shell:` value other than a literal false
  ['shell: true', `${CP}spawnSync('x', [], { shell: true });\n`, /shell/],
  ['shell: string', `${CP}spawnSync('x', [], { shell: 'bash' });\n`, /shell/],
  ['shell: expression', `${CP}spawnSync('x', [], { shell: process.platform === 'win32' });\n`, /shell/],
  ['shell: quoted key', `${CP}spawnSync('x', [], { 'shell': true });\n`, /shell/],
  ['shell: double-quoted key', `${CP}spawnSync('x', [], { "shell": true });\n`, /shell/],
  ['shell: value on the next line', `${CP}spawnSync('x', [], {\n  shell:\n    true,\n});\n`, /shell/],
  ['shell: variable', `${CP}const s = true;\nspawnSync('x', [], { shell: s });\n`, /shell/],
  ['shell: assigned afterwards', `${CP}const o = {};\no.shell = true;\n`, /shell/],
  ['shell: marker on another line', `// audit:allow-shell — reason\n${CP}spawnSync('x', [], { shell: true });\n`, /shell/],
  // (b) child_process loaded without a static import
  ['require', "const cp = require('child_process');\n", /static import/],
  ['require node: prefix', 'const cp = require("node:child_process");\n', /static import/],
  ['dynamic import', "const cp = await import('node:child_process');\n", /static import/],
  ['dynamic import, destructured', "const { spawnSync } = await import('child_process');\n", /static import/],
  ['getBuiltinModule', "const cp = process.getBuiltinModule('node:child_process');\n", /static import/],
  // (c) exec / execSync reached through an alias, a destructure or an import
  ['execSync call', "execSync(`git ${x}`);\n", /execSync/],
  ['named import of execSync', "import { execSync } from 'child_process';\n", /execSync/],
  ['named import of exec', "import { exec } from 'node:child_process';\n", /exec/],
  ['renamed import of execSync', "import { execSync as run } from 'child_process';\n", /execSync/],
  ['multi-line import of exec', "import {\n  spawnSync,\n  exec,\n} from 'node:child_process';\n", /exec/],
  ['re-export of execSync', "export { execSync } from 'child_process';\n", /execSync/],
  ['default alias .exec', "import cp from 'child_process';\ncp.exec('x');\n", /cp\.exec/],
  ['default alias .execSync', "import cp from 'node:child_process';\ncp.execSync('x');\n", /cp\.execSync/],
  ['namespace alias ["execSync"]', "import * as cp from 'child_process';\ncp['execSync']('x');\n", /cp\.execSync/],
  ['namespace alias ["exec"]', 'import * as cp from "child_process";\ncp["exec"]("x");\n', /cp\.exec/],
  ['optional-chained alias', "import cp from 'child_process';\ncp?.exec('x');\n", /cp\.exec/],
  ['promisify(cp.exec)', "import cp from 'child_process';\nimport { promisify } from 'util';\nconst run = promisify(cp.exec);\n", /cp\.exec/],
  ['alias without a call', "import * as cp from 'child_process';\nconst run = cp.execSync;\n", /cp\.execSync/],
  ['default plus named import', "import cp, { spawnSync } from 'child_process';\ncp.exec('x');\n", /cp\.exec/],
  ['destructured rename', "import cp from 'child_process';\nconst { execSync: run } = cp;\n", /execSync/],
  ['destructured exec', "import cp from 'child_process';\nconst { exec } = cp;\n", /exec/],
  ['destructured with a default', "import cp from 'child_process';\nlet { exec = null } = cp;\n", /exec/],
  // (d) shells named as string literals
  ...['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'PowerShell.EXE', '/bin/sh', '/usr/bin/bash', 'C:\\\\Windows\\\\System32\\\\cmd.exe']
    .flatMap((name) => [
      [`shell name '${name}'`, `${CP}spawnSync('${name}', ['-c', 'x']);\n`, /names a shell/],
      [`shell name "${name}"`, `${CP}spawnSync("${name}", ['-c', 'x']);\n`, /names a shell/],
      [`shell name \`${name}\``, `${CP}spawnSync(\`${name}\`, ['-c', 'x']);\n`, /names a shell/],
    ]),
  // The scanner must not be fooled into reading code as a comment or string.
  ['URL in a string before a call', "const u = 'http://x'; execSync(u);\n", /execSync/],
  ['URL in a template before a call', 'const u = `http://${host}/x`; execSync(u);\n', /execSync/],
  ['quote inside a regex literal', "const re = /['\"]/g; execSync(x);\n", /execSync/],
  ['division before a call', 'const q = a / b; execSync(q); const r = c / d;\n', /execSync/],
  ['call inside a template expression', 'const s = `${execSync(x)}`;\n', /execSync/],
  ['shebang line, then a call', '#!/usr/bin/env node\nexecSync(x);\n', /execSync/],
];

for (const [name, source, pattern] of bypasses) {
  const found = scan(source);
  check(`catches: ${name}`, found.length > 0 && found.some((v) => pattern.test(v.details)),
    `violations: ${JSON.stringify(found.map((v) => v.details))}`);
  check(`kind is shell-exec: ${name}`, found.every((v) => v.kind === 'shell-exec'));
}

// Sources that must stay clean.
const clean = [
  ['spawnSync with an argument array', `${CP}spawnSync('git', ['status']);\n`],
  ['execFileSync', "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status']);\n"],
  ['shell: false', `${CP}spawnSync('x', [], { shell: false });\n`],
  ['shell:false, no spaces', `${CP}spawnSync('x', [], {shell:false});\n`],
  ['shell : false, spaced', `${CP}spawnSync('x', [], { shell : false });\n`],
  ['allowed shell line', `${CP}spawnSync('npm.cmd', [], {\n  shell: true, // audit:allow-shell — reviewed\n});\n`],
  ['RegExp.exec on an identifier', `${CP}const m = re.exec(line);\n`],
  ['RegExp.exec on a literal', `${CP}const m = /a(b)/.exec(line);\n`],
  ['RegExp.exec beside a child_process alias', "import cp from 'child_process';\ncp.spawnSync('x', []);\nconst m = re.exec(line);\n"],
  ['member named exec on another object', "import cp from 'child_process';\nconst m = other.exec(line);\ncp.spawnSync('x', []);\n"],
  ['line comment mentioning execSync(', '// never call execSync(cmd) here\nexport const x = 1;\n'],
  ['block comment mentioning execSync(', '/* never call execSync(cmd)\n   or shell: true */\nexport const x = 1;\n'],
  ['comment mentioning require of child_process', "// no require('child_process') here\nexport const x = 1;\n"],
  ['comment after a URL string', "const u = 'http://x'; // execSync(u)\n"],
  ['comment after a division', 'const q = a / b; // execSync(q)\n'],
  ['comment after a regex literal with a quote', "const re = /['\"]/g; // execSync(x)\n"],
  ['comment-looking text in a template', 'const s = `// not a comment ${x} /* nor this */`;\nexport const y = 1;\n'],
  ['shell names without a child_process import', "const shells = ['sh', 'bash', \"cmd.exe\"];\n"],
  ['a non-shell string with a shell-like substring', `${CP}spawnSync('bashful', ['shell']);\n`],
  ['shebang then clean code', '#!/usr/bin/env node\nexport const x = 1;\n'],
  ['empty file', ''],
];

for (const [name, source] of clean) {
  const found = scan(source);
  check(`clean: ${name}`, found.length === 0, `violations: ${JSON.stringify(found.map((v) => v.details))}`);
}

// The marker exempts only the line that carries it.
{
  const source = `${CP}spawnSync('a', [], { shell: true }); // audit:allow-shell — reviewed\nspawnSync('b', [], { shell: true });\n`;
  const found = scan(source);
  check('marker exempts only its own line', found.length === 1 && /:3:/.test(found[0].details),
    `violations: ${JSON.stringify(found.map((v) => v.details))}`);
}

// Messages carry path and line number.
{
  const found = scanShellExec('lib/x.mjs', "const a = 1;\n\nexecSync('x');\n");
  check('details start with path:line:', found.length === 1 && found[0].details.startsWith('lib/x.mjs:3: '),
    `details: ${found[0]?.details}`);
}

// A file the scanner cannot read to the end is reported, not trusted.
for (const [name, source] of [
  ['unterminated string', "const s = 'abc;\nexport const x = 1;\n"],
  ['unterminated template', 'const s = `abc;\nexport const x = 1;\n'],
  ['unterminated block comment', '/* never closed\nexport const x = 1;\n'],
]) {
  const found = scan(source);
  check(`reports: ${name}`, found.some((v) => /could not scan/.test(v.details)),
    `violations: ${JSON.stringify(found.map((v) => v.details))}`);
}

// stripComments keeps offsets and newlines, so line numbers stay true.
{
  const source = "a // c1\n/* c2\n c3 */ b 'x // y' `t // u ${1 /* c4 */}`\nconst r = /[//]x/; end\n";
  const stripped = stripComments(source);
  check('stripComments preserves length', stripped.length === source.length);
  check('stripComments preserves newlines',
    [...source].map((c, i) => (c === '\n') === (stripped[i] === '\n')).every(Boolean));
  check('stripComments blanks comments', !/c[1-4]/.test(stripped), `stripped: ${JSON.stringify(stripped)}`);
  check('stripComments keeps string text', stripped.includes("'x // y'") && stripped.includes('`t // u ${1'));
  check('stripComments keeps regex literals', stripped.includes('/[//]x/'));
}

// Which files the check looks at.
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shell-scan-test-')));
  try {
    const bad = "execSync('x');\n";
    const files = {
      'template/_claude/scripts/a.mjs': bad,
      'lib/b.mjs': bad,
      'bin/c.mjs': bad,
      'template/_claude/scripts/d.test.mjs': bad,
      'scripts/e.mjs': bad,
      'template/_claude/scripts/f.js': bad,
      'template/CLAUDE.md.tmpl': bad,
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const list = [...Object.keys(files), 'lib/missing.mjs'].map((path) => ({ path }));
    const found = scanShellExecFiles(list, root).map((v) => v.details.split(':')[0]).sort();
    check('scans non-test .mjs under template/, lib/ and bin/ only',
      JSON.stringify(found) === JSON.stringify(['bin/c.mjs', 'lib/b.mjs', 'template/_claude/scripts/a.mjs']),
      `scanned: ${JSON.stringify(found)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The code this repo ships passes.
{
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files.push({ path });
    }
  };
  for (const dir of ['template', 'lib', 'bin']) walk(dir);
  const shipped = files.filter((f) => f.path.endsWith('.mjs') && !f.path.endsWith('.test.mjs'));
  check('found shipped sources to scan', shipped.length > 50, `found ${shipped.length}`);
  const found = scanShellExecFiles(files, REPO_ROOT);
  check('shipped code has no shell-exec violations', found.length === 0,
    `violations:\n      ${found.map((v) => v.details).join('\n      ')}`);
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
