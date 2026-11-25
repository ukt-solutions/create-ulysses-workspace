#!/usr/bin/env node
// Test for what /workspace-init finds after each scaffold entry point.
// Run: node lib/workspace-init.test.mjs
//
// A workspace reaches /workspace-init two ways: `npm create` (lib/scaffold.mjs
// installs the whole template, then bin/create.mjs runs initGit) and `--init`
// (lib/init.mjs installs the bootstrap pieces only). Both must leave the state
// the skill's mode table routes to Init — `workspace.initialized` not true and
// an "action": "init" payload at .workspace-update/ — because an uninitialized
// workspace without a payload is told to run `--init` instead, which is no
// answer for a user who just ran `npm create` (ulysses-workspace#219).
//
// Step 5 then walks the payload and asks about each file it cannot find
// locally or that differs. After `npm create` there must be nothing to ask:
// the scaffold already installed the template, and the only payload files
// missing locally are the `.skip` twins of rules its prompts activated.
//
// After `--init` the walk has real work: it must reach every directory the
// payload ships under .claude/, or a directory it does not list is never
// installed. One file is Step 5's by design even so: .mcp.json. The payload
// carries it and the CLI does not install it, because the project being
// initialized may already have its own, so the skill installs it with the
// user's yes.
import { scaffold } from './scaffold.mjs';
import { initWorkspace } from './init.mjs';
import { initGit } from './git.mjs';
import { classifyUpdate } from '../template/_claude/scripts/classify-update.mjs';
import { execFileSync, spawnSync } from 'child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync,
  existsSync, readFileSync, writeFileSync, realpathSync,
} from 'fs';
import { dirname, join } from 'path';
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

const here = dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
const skill = readFileSync(join(here, '..', 'template', '_claude', 'skills', 'workspace-init', 'SKILL.md'), 'utf8');

// One numbered step of the skill: the text from its heading to the next.
function skillStep(number) {
  const start = skill.indexOf(`### Step ${number}:`);
  if (start === -1) return '';
  const next = skill.indexOf('\n### ', start + 1);
  return skill.slice(start, next === -1 ? undefined : next);
}
const step5 = skillStep(5);

// Every file under dir, as slash-separated paths relative to it.
function filesUnder(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesUnder(join(dir, entry.name), rel) : [rel];
    });
}

// The rows of the skill's mode table for a workspace that is not yet
// initialized: an init payload means Init, no payload means stop.
function initMode(root) {
  const config = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8'));
  if (config.workspace?.initialized === true) return 'already initialized';
  const manifest = join(root, '.workspace-update', '.manifest.json');
  if (!existsSync(manifest)) return 'stop: no payload';
  const { action } = JSON.parse(readFileSync(manifest, 'utf8'));
  return action === 'init' ? 'Init' : `stop: ${action} payload`;
}

// A JSON config that needs nothing more: installed, parseable, and equal to
// the payload's on every key.
function isSettled(entry) {
  return entry !== undefined && !entry.notInstalled && !entry.unparseable
    && ['added', 'workspaceOnly', 'changed', 'arrays'].every((key) => entry[key].length === 0);
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-init-test-')));

// Hermetic git for initGit's commit: a fixed identity and an empty global
// config, so the user's signing, hooks, or default-branch settings cannot
// change the outcome.
writeFileSync(join(base, 'gitconfig'), '');
const savedEnv = {};
const hermetic = {
  GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
for (const [k, v] of Object.entries(hermetic)) { savedEnv[k] = process.env[k]; process.env[k] = v; }

// initWorkspace() narrates what it does; keep that out of the test output.
const narrate = console.log;
console.log = () => {};

try {
  // `npm create`: the interactive scaffold, then the git commit bin/create.mjs makes.
  // Two optional rules are activated at the prompts, as a user can do.
  const activated = ['cloud-infrastructure', 'scope-guard'];
  const created = join(base, 'created');
  await scaffold({
    name: 'demo',
    directory: created,
    repos: [],
    userName: 'tester',
    activateRules: activated,
  });
  await initGit(created);

  // `--init <dir>`
  const flagged = join(base, 'flagged');
  await initWorkspace(flagged);

  // The mode table
  check('`npm create`: /workspace-init selects Init', initMode(created) === 'Init');
  check('`--init`: /workspace-init selects Init', initMode(flagged) === 'Init');

  // What the rest of the flow reads from the payload
  for (const [label, root] of [['`npm create`', created], ['`--init`', flagged]]) {
    const manifestPath = join(root, '.workspace-update', '.manifest.json');
    check(`${label}: payload carries the workspace-init skill the hook points at`,
      existsSync(join(root, '.workspace-update', '.claude', 'skills', 'workspace-init', 'SKILL.md')));
    check(`${label}: workspace.json is what the skill reads first`, existsSync(join(root, 'workspace.json')));
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    check(`${label}: manifest templateVersion is the package version (${pkgVersion})`,
      manifest.templateVersion === pkgVersion);
  }

  // The interactive flow commits right after scaffolding. The payload is
  // transient input for Step 15 to delete, so that commit must not track it.
  const tracked = execFileSync('git', ['ls-files'], { cwd: created, encoding: 'utf-8' }).split('\n').filter(Boolean);
  check('`npm create`: the initial commit does not track the payload',
    tracked.every((path) => !path.startsWith('.workspace-update/')));
  check('`npm create`: the initial commit tracks the workspace files',
    ['CLAUDE.md', 'workspace.json', '.gitignore', '.mcp.json'].every((path) => tracked.includes(path)));
  check('`npm create`: the payload leaves the working tree clean',
    execFileSync('git', ['status', '--porcelain'], { cwd: created, encoding: 'utf-8' }).trim() === '');

  // Step 5 asks about a payload file it cannot find locally or that differs.
  // The classifier answers the same three questions — missing, different,
  // identical — plus the activated-rule case, so run it on the real scaffold.
  const classified = classifyUpdate({ root: created, payload: join(created, '.workspace-update') });
  for (const list of ['new', 'updated', 'differs', 'localOnly', 'deletedLocally', 'removed']) {
    check(`\`npm create\`: Step 5 has nothing to handle (${list})`, classified[list].length === 0);
  }
  check('`npm create`: every payload component file is already installed and identical',
    classified.identical.length > 0);
  check('`npm create`: the only files missing locally are the .skip twins of activated rules',
    JSON.stringify(classified.activated) === JSON.stringify(
      activated.map((name) => ({ skip: `.claude/rules/${name}.md.skip`, active: `.claude/rules/${name}.md` })),
    ));
  check('`npm create`: the two JSON configs need no merge',
    classified.config.length === 2 && classified.config.every(isSettled));

  // The one command Step 5 runs — rewriting the baseline from the payload —
  // must be a no-op there: the scaffold wrote the same baseline from the
  // template tree.
  const rewritten = spawnSync(process.execPath,
    [join(created, '.claude', 'scripts', 'classify-update.mjs'), '--root', '.', '--write-baseline', '--payload', '.workspace-update'],
    { cwd: created, encoding: 'utf-8' });
  check('`npm create`: Step 5 writes the baseline without error', rewritten.status === 0);
  check('`npm create`: rewriting the baseline changes nothing', JSON.parse(rewritten.stdout).written === true
    && execFileSync('git', ['status', '--porcelain'], { cwd: created, encoding: 'utf-8' }).trim() === '');

  // Step 5's walk has to list every directory the payload ships under .claude/:
  // one it does not list is never installed after `--init`, yet the baseline
  // records its files, so /workspace-update reports them as deleted locally.
  const payloadClaude = join(flagged, '.workspace-update', '.claude');
  const payloadDirs = readdirSync(payloadClaude, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const listed = /For each [^\n]*directory[^\n]*?— ([^:\n]+):/.exec(step5);
  const listedDirs = (listed ? listed[1] : '').split(',').map((name) => name.trim()).filter(Boolean).sort();
  check(`skill: Step 5 lists every directory the payload ships under .claude/ `
    + `(skill: ${listedDirs.join(', ') || 'list not found'}; payload: ${payloadDirs.join(', ')})`,
    JSON.stringify(listedDirs) === JSON.stringify(payloadDirs));

  // Step 5 installs .mcp.json after `--init`. The classifier tells the three
  // cases in the skill apart: not installed, identical, or the workspace's own.
  const mcpEntry = (root) => classifyUpdate({ root, payload: join(root, '.workspace-update') })
    .config.find((entry) => entry.path === '.mcp.json');
  const mcpAt = (root) => readFileSync(join(root, '.mcp.json'), 'utf8');

  check('`--init`: the payload carries .mcp.json and the root does not',
    existsSync(join(flagged, '.workspace-update', '.mcp.json')) && !existsSync(join(flagged, '.mcp.json')));
  check('`--init`: Step 5 sees .mcp.json as not installed', mcpEntry(flagged)?.notInstalled === true);

  // "Install .mcp.json from the template? [Y/n]" — answered yes: the payload's copy.
  cpSync(join(flagged, '.workspace-update', '.mcp.json'), join(flagged, '.mcp.json'));
  check('`--init`: after Step 5, .mcp.json is at the root, exactly the payload\'s',
    mcpAt(flagged) === readFileSync(join(flagged, '.workspace-update', '.mcp.json'), 'utf8'));
  const installed = JSON.parse(mcpAt(flagged));
  check('`--init`: the installed .mcp.json declares its MCP servers',
    typeof installed.mcpServers === 'object' && installed.mcpServers !== null);
  check('`--init`: the next /workspace-update has nothing left to install or merge for .mcp.json',
    isSettled(mcpEntry(flagged)));

  // `--init` inside a project that already has its own .mcp.json. The file is
  // the workspace's, so Step 5 asks whether to add the template's servers and
  // never copies the payload over it.
  const own = join(base, 'own-mcp');
  await initWorkspace(own);
  writeFileSync(join(own, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { mine: { command: 'npx', args: ['my-server'] } } }, null, 2)}\n`);
  const ownEntry = mcpEntry(own);
  check('own .mcp.json: not read as missing', ownEntry !== undefined && !ownEntry.notInstalled);
  check('own .mcp.json: adding the template\'s server is the merge Step 5 offers',
    JSON.stringify(ownEntry?.added) === '["mcpServers/playwright"]'
    && JSON.stringify(ownEntry?.workspaceOnly) === '["mcpServers/mine"]');

  // The rest of Step 5 after `--init`, with every "Install {file}?" answered
  // yes: each file the walk covers that is missing locally is copied from the
  // payload. The walk covers the directories the skill lists, plus
  // .claude/settings.json, which has its own top-level rule. That must leave
  // nothing for /workspace-update to report as missing — recipes/ is the
  // directory the walk used to leave out, and Step 7 reads it.
  const walked = (rel) => listedDirs.includes(rel.split('/')[0]) || rel === 'settings.json';
  const payloadFiles = filesUnder(payloadClaude).filter(walked);
  for (const rel of payloadFiles) {
    const dest = join(flagged, '.claude', rel);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(payloadClaude, rel), dest);
  }
  check('`--init`: after Step 5, the recipes Step 7 reads are installed',
    existsSync(join(flagged, '.claude', 'recipes', 'migrate-from-notion.md')));
  const afterStep5 = classifyUpdate({ root: flagged, payload: join(flagged, '.workspace-update') });
  check('`--init`: after Step 5, no payload file is missing from the workspace',
    afterStep5.new.length === 0 && afterStep5.deletedLocally.length === 0);
  check('`--init`: after Step 5, every component file equals the payload\'s',
    afterStep5.updated.length === 0 && afterStep5.differs.length === 0
    && afterStep5.identical.length === payloadFiles.length
    && afterStep5.config.length === 2 && afterStep5.config.every(isSettled));

  // The skill says so.
  check('skill: Step 5 leaves the .skip twin of an active rule alone', step5.includes('`{name}.md.skip`'));
  check('skill: Step 5 installs .mcp.json from the payload', step5.includes('**`.mcp.json`**'));
  check('skill: Step 5 commits only when it has something to commit', step5.includes('**Commit (if '));
  check('skill: Step 14 counts .mcp.json as a template file', skillStep(14).includes('`.mcp.json`'));
  check('skill: Step 15 does not move .mcp.json to unmigrated', !/\.mcp\.json →/.test(skillStep(15)));
} finally {
  console.log = narrate;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
