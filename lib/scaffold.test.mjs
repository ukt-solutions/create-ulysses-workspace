#!/usr/bin/env node
// End-to-end test for scaffold.mjs — the template install behind `npm create`.
// Run: node lib/scaffold.test.mjs
//
// The template stores .gitignore, .claude/, and .mcp.json under the inert
// names _gitignore, _claude/, and _mcp.json (Claude Code protects the live
// names from headless edits). scaffold() must install every one under its
// live name and leave no inert leftovers behind. It must also create the
// canonical directory at workspace-context/shared/locked/ — the path
// build-workspace-context.mjs reads — and not workspace-context/locked/,
// which nothing reads.
//
// It must also leave the same "action": "init" payload --init stages at
// .workspace-update/. /workspace-init reads that payload to decide what to
// do: an uninitialized workspace without one is told to run --init instead,
// which is no answer for a user who just ran `npm create`.
//
// And it must write into an empty directory only. The install is in place —
// each template file replaces whatever has the same name — so a directory
// that already has files is refused before the first write and left exactly
// as it was. A directory that does not exist yet, an empty one, and one
// holding nothing but a repo with nothing checked out are all fine
// (ulysses-workspace#223).
import { scaffold, scaffoldRefusal } from './scaffold.mjs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

let failed = 0;
let passed = 0;
function check(label, ok) {
  if (ok) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

const templateDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'template');
const answers = { name: 'demo', repos: [], userName: 'tester', activateRules: [] };

// scaffold() aimed at a directory it may have to refuse: the error it threw,
// or null when it went ahead.
function scaffoldInto(directory) {
  return scaffold({ ...answers, directory }).then(() => null, (err) => err);
}

// Everything under dir as "path from dir → bytes", so two snapshots can be
// compared byte for byte. Line endings are never normalized: a CRLF file has
// to come out exactly as it went in.
function snapshot(dir, prefix = '') {
  const files = {};
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, snapshot(join(dir, entry.name), rel));
    else files[rel] = readFileSync(join(dir, entry.name));
  }
  return files;
}

// The paths whose bytes or presence differ between two snapshots.
function differences(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((rel) => !before[rel] || !after[rel] || !before[rel].equals(after[rel]));
}

// What is on disk when the scaffold is pointed at a directory already in use.
// The .gitignore carries CRLF, as it would on a Windows checkout.
const OWN_FILES = {
  '.gitignore': '# keep build output out of git\r\nbuild/\r\n.env\r\n',
  '.mcp.json': `${JSON.stringify({ mcpServers: { 'team-tools': { command: 'npx', args: ['team-mcp'] } } }, null, 2)}\n`,
  'CLAUDE.md': '# Our conventions\n\nRun the tests before every commit.\n',
  '.claude/settings.json': '{\n  "permissions": {\n    "allow": ["Bash(npm run test:*)"]\n  }\n}\n',
};

const base = mkdtempSync(join(tmpdir(), 'scaffold-test-'));

try {
  // ---- An empty directory: the install itself ----
  const directory = join(base, 'empty');
  mkdirSync(directory);
  await scaffold({ ...answers, directory });

  // Live names installed
  check('.claude/ directory installed', existsSync(join(directory, '.claude')));
  check('.claude/settings.json installed', existsSync(join(directory, '.claude', 'settings.json')));
  check('.claude/settings.local.json written', existsSync(join(directory, '.claude', 'settings.local.json')));
  check('.claude/rules/ installed', existsSync(join(directory, '.claude', 'rules')));
  check('.claude/rules/coherent-revisions.md installed', existsSync(join(directory, '.claude', 'rules', 'coherent-revisions.md')));
  check('.mcp.json installed', existsSync(join(directory, '.mcp.json')));
  check('.gitignore installed', existsSync(join(directory, '.gitignore')));
  check('.gitignore is the template\'s _gitignore, byte for byte',
    readFileSync(join(directory, '.gitignore')).equals(readFileSync(join(templateDir, '_gitignore'))));
  check('.mcp.json is the template\'s _mcp.json, byte for byte',
    readFileSync(join(directory, '.mcp.json')).equals(readFileSync(join(templateDir, '_mcp.json'))));

  // .mcp.json is the template's payload, unmodified
  const mcp = JSON.parse(readFileSync(join(directory, '.mcp.json'), 'utf8'));
  check('.mcp.json parses with mcpServers object', typeof mcp.mcpServers === 'object' && mcp.mcpServers !== null);

  // Inert names are gone
  check('no _claude/ leftover', !existsSync(join(directory, '_claude')));
  check('no _mcp.json leftover', !existsSync(join(directory, '_mcp.json')));
  check('no _gitignore leftover', !existsSync(join(directory, '_gitignore')));

  // Only the root *.tmpl files are skipped: they are rendered into place.
  // A *.tmpl inside a skill is skill content — /build-docs-site reads its
  // templates/ when it runs — and must arrive like any other file.
  check('no root .tmpl copied as-is',
    !existsSync(join(directory, 'CLAUDE.md.tmpl')) && !existsSync(join(directory, 'workspace.json.tmpl')));
  check("the template's own .npmignore is not copied", !existsSync(join(directory, '.npmignore')));
  check('/build-docs-site templates installed',
    ['custom.css.tmpl', 'docusaurus.config.ts.tmpl', 'sidebars.ts.tmpl', 'spec.md.tmpl'].every((name) =>
      existsSync(join(directory, '.claude', 'skills', 'build-docs-site', 'templates', name))));

  // Canonical directory: where build-workspace-context.mjs reads from
  check('workspace-context/shared/locked/ created', existsSync(join(directory, 'workspace-context', 'shared', 'locked')));
  check('workspace-context/locked/ not created', !existsSync(join(directory, 'workspace-context', 'locked')));

  // Template baseline: hashes of the verbatim-installed files, for three-way
  // update classification (gh:183)
  const baselinePath = join(directory, '.claude', '.template-baseline.json');
  check('template baseline written', existsSync(baselinePath));
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  check(`baseline records the package version (${pkgVersion})`, baseline.templateVersion === pkgVersion);
  check(
    'baseline covers rules installed verbatim from the template',
    typeof baseline.files['.claude/rules/coherent-revisions.md'] === 'string',
  );
  check(
    'baseline covers .mcp.json via its inert source name',
    typeof baseline.files['.mcp.json'] === 'string' && typeof baseline.files['.claudeignore'] === 'string',
  );
  check(
    'baseline never covers tests or machine-local files',
    Object.keys(baseline.files).every((k) => !k.endsWith('.test.mjs') && k !== '.claude/settings.local.json'),
  );

  // The init payload /workspace-init reads (the same one --init stages)
  const payloadDir = join(directory, '.workspace-update');
  const manifestPath = join(payloadDir, '.manifest.json');
  check('init payload staged at .workspace-update/', existsSync(payloadDir));
  check('payload manifest written', existsSync(manifestPath));
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    check('manifest declares an init payload', manifest.action === 'init');
    check(`manifest records the package version (${pkgVersion})`, manifest.templateVersion === pkgVersion);
  }
  check('payload carries .claude/ under its live name',
    existsSync(join(payloadDir, '.claude', 'skills', 'workspace-init', 'SKILL.md')));
  check('payload carries no inert _claude/ or _mcp.json',
    !existsSync(join(payloadDir, '_claude')) && !existsSync(join(payloadDir, '_mcp.json')));
  const workspaceJson = JSON.parse(readFileSync(join(directory, 'workspace.json'), 'utf8'));
  check('workspace is left for /workspace-init to initialize', workspaceJson.workspace.initialized !== true);

  // ---- A directory that does not exist yet ----
  // Its parent is missing too: the scaffold creates both.
  const notYet = join(base, 'not-yet', 'new-workspace');
  check('a directory that does not exist yet is accepted', (await scaffoldInto(notYet)) === null);
  check('… and is created, with the workspace installed',
    ['CLAUDE.md', 'workspace.json', '.gitignore', '.mcp.json'].every((rel) => existsSync(join(notYet, rel))));

  // ---- A directory holding nothing but a fresh repo and OS files ----
  const fresh = join(base, 'fresh-repo');
  mkdirSync(join(fresh, '.git', 'objects'), { recursive: true });
  writeFileSync(join(fresh, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(fresh, '.DS_Store'), 'Finder writes this');
  writeFileSync(join(fresh, 'Thumbs.db'), 'Explorer writes this');
  const freshBefore = snapshot(fresh);
  check('a directory holding only .git, .DS_Store and Thumbs.db is accepted', (await scaffoldInto(fresh)) === null);
  const freshAfter = snapshot(fresh);
  check('… with the workspace installed beside them', existsSync(join(fresh, 'workspace.json')));
  check('… and the repo marker and OS files untouched',
    Object.keys(freshBefore).every((rel) => freshAfter[rel]?.equals(freshBefore[rel])));

  // ---- A directory that already has files ----
  const own = join(base, 'existing-project');
  for (const [rel, content] of Object.entries(OWN_FILES)) {
    mkdirSync(dirname(join(own, rel)), { recursive: true });
    writeFileSync(join(own, rel), content);
  }
  const ownBefore = snapshot(own);
  const refusal = await scaffoldInto(own);
  const ownAfter = snapshot(own);

  check('a directory that already has files is refused', refusal instanceof Error);
  check('the refusal names the directory', refusal?.message.includes(resolve(own)));
  check('the refusal says why: the scaffold would replace the files there',
    /already has files/.test(refusal?.message) && /replace/.test(refusal?.message));
  check('the refusal names the alternative: --init <dir>',
    refusal?.message.includes('npx @ulysses-ai/create-workspace@beta --init <dir>'));

  check('.gitignore survives, byte for byte', ownAfter['.gitignore']?.equals(Buffer.from(OWN_FILES['.gitignore'])));
  check('.mcp.json survives, byte for byte', ownAfter['.mcp.json']?.equals(Buffer.from(OWN_FILES['.mcp.json'])));
  check('CLAUDE.md survives, byte for byte', ownAfter['CLAUDE.md']?.equals(Buffer.from(OWN_FILES['CLAUDE.md'])));
  const changed = differences(ownBefore, ownAfter);
  const changedList = `${changed.slice(0, 4).join(', ')}${changed.length > 4 ? `, … and ${changed.length - 4} more` : ''}`;
  check(`nothing was written: the directory holds exactly what it held${changed.length ? ` (changed: ${changedList})` : ''}`,
    changed.length === 0);

  // ---- The same question, asked directly ----
  // The Directory prompt uses scaffoldRefusal() as its validate, so it has to
  // answer for every kind of path — answering, never throwing.
  check('scaffoldRefusal(): null for a directory that does not exist yet', scaffoldRefusal(join(base, 'nowhere')) === null);
  const stillEmpty = join(base, 'still-empty');
  mkdirSync(stillEmpty);
  check('scaffoldRefusal(): null for an empty directory', scaffoldRefusal(stillEmpty) === null);
  check('scaffoldRefusal(): a reason for a directory that already has files', typeof scaffoldRefusal(own) === 'string');

  const notADirectory = join(base, 'not-a-directory');
  writeFileSync(notADirectory, 'just a file');
  const fileRefusal = await scaffoldInto(notADirectory);
  check('a path that is a file is refused', /is not a directory/.test(fileRefusal?.message));
  check('… and the file is left alone', readFileSync(notADirectory, 'utf8') === 'just a file');

  // A path Node refuses to read — readdirSync throws something that is
  // neither ENOENT nor ENOTDIR. A validate that threw here would take the
  // prompt down with it.
  const unreadable = scaffoldRefusal(join(base, 'bad\0path'));
  check('scaffoldRefusal() answers, rather than throwing, when the directory cannot be read',
    typeof unreadable === 'string' && /cannot be read/.test(unreadable));
} finally {
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
