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
import { scaffold } from './scaffold.mjs';
import { initWorkspace } from './init.mjs';
import { initGit } from './git.mjs';
import { execFileSync } from 'child_process';
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
  const created = join(base, 'created');
  await scaffold({
    name: 'demo',
    directory: created,
    repos: [],
    userName: 'tester',
    activateRules: [],
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
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: created, encoding: 'utf-8' });
  check('`npm create`: the payload leaves the working tree clean', status.trim() === '');
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
