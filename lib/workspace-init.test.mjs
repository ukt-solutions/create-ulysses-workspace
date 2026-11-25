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
// answer for a user who just ran `npm create` (gh:219).
//
// Step 5 then walks the payload and asks about each file it cannot find
// locally or that differs. After `npm create` there must be nothing to ask:
// the scaffold already installed the template, and the only payload files
// missing locally are the `.skip` twins of rules its prompts activated.
import { scaffold } from './scaffold.mjs';
import { initWorkspace } from './init.mjs';
import { initGit } from './git.mjs';
import { classifyUpdate } from '../template/_claude/scripts/classify-update.mjs';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

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
    classified.config.length === 2 && classified.config.every((entry) => !entry.notInstalled
      && !entry.unparseable
      && ['added', 'workspaceOnly', 'changed', 'arrays'].every((key) => entry[key].length === 0)));

  // The one command Step 5 runs — rewriting the baseline from the payload —
  // must be a no-op there: the scaffold wrote the same baseline from the
  // template tree.
  const rewritten = spawnSync(process.execPath,
    [join(created, '.claude', 'scripts', 'classify-update.mjs'), '--root', '.', '--write-baseline', '--payload', '.workspace-update'],
    { cwd: created, encoding: 'utf-8' });
  check('`npm create`: Step 5 writes the baseline without error', rewritten.status === 0);
  check('`npm create`: rewriting the baseline changes nothing', JSON.parse(rewritten.stdout).written === true
    && execFileSync('git', ['status', '--porcelain'], { cwd: created, encoding: 'utf-8' }).trim() === '');

  // The skill says so: Step 5 leaves an activated rule alone, and only commits
  // when it installed something.
  const step5 = skillStep(5);
  check('skill: Step 5 does not install the .skip twin of an active rule', step5.includes('`{name}.md.skip`'));
  check('skill: Step 5 commits only when it has something to commit', step5.includes('**Commit (if '));
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
