#!/usr/bin/env node
// Unit tests for upgrade.mjs
// Run: node lib/upgrade.test.mjs
//
// Covers the tracked-payload warning: .workspace-update/ is gitignored from
// v0.19.0, but a workspace upgraded from an older template may still carry a
// tracked payload from a previous run — --upgrade must say so.
import { upgradeWorkspace } from './upgrade.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync, spawnSync } from 'child_process';

let failed = 0;
let passed = 0;
function check(label, ok) {
  if (ok) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function captureConsole(fn) {
  const out = { log: [], error: [] };
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => { out.log.push(a.join(' ')); };
  console.error = (...a) => { out.error.push(a.join(' ')); };
  try {
    return { result: fn(), out };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

function buildWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-test-'));
  execSync('git init -q -b main', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email test@example.com', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name Test', { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({
    workspace: { name: 'demo', initialized: true, templateVersion: '0.15.0' },
    repos: {},
  }, null, 2) + '\n');
  execSync('git add workspace.json', { cwd: root, stdio: 'pipe' });
  execSync('git commit -q -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

function lsFilesPayload(root) {
  return spawnSync('git', ['ls-files', '.workspace-update'], {
    cwd: root,
    encoding: 'utf-8',
  }).stdout.split('\n').filter(Boolean);
}

console.log('# upgrade');

// 1. Clean workspace: payload staged, no tracked-payload warning, and the
//    freshly staged payload is not tracked.
{
  const root = buildWorkspace();
  try {
    const { out } = captureConsole(() => upgradeWorkspace(root));
    const stderr = out.error.join('\n');
    check('no tracked-payload warning on a clean workspace',
      !stderr.includes('git rm -r --cached'));
    check('payload staged', existsSync(join(root, '.workspace-update', '.manifest.json')));
    check('freshly staged payload is not tracked', lsFilesPayload(root).length === 0);
    check('staging reported', out.log.join('\n').includes('Staged template payload'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 2. Workspace tracking .workspace-update/ from a pre-v0.19 upgrade: the
//    warning fires and names the untrack command.
{
  const root = buildWorkspace();
  try {
    // Simulate the old behavior: a payload committed tracked.
    const payload = join(root, '.workspace-update');
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, '.manifest.json'), '{"action":"upgrade"}\n');
    execSync('git add -f .workspace-update', { cwd: root, stdio: 'pipe' });
    execSync('git commit -q -m "track payload"', { cwd: root, stdio: 'pipe' });
    check('fixture really tracks the payload', lsFilesPayload(root).length > 0);

    const { out } = captureConsole(() => upgradeWorkspace(root));
    const stderr = out.error.join('\n');
    check('tracked-payload warning fires', stderr.includes('.workspace-update/') && stderr.includes('tracked by git'));
    check('warning names the untrack command', stderr.includes('git rm -r --cached .workspace-update'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 3. Not a git repo at all: staging still works, warning stays silent.
{
  const root = mkdtempSync(join(tmpdir(), 'upgrade-nogit-'));
  try {
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({
      workspace: { name: 'demo', initialized: true, templateVersion: '0.15.0' },
      repos: {},
    }, null, 2) + '\n');
    const { out } = captureConsole(() => upgradeWorkspace(root));
    check('no warning outside a git repo', !out.error.join('\n').includes('tracked by git'));
    check('payload staged outside a git repo', existsSync(join(root, '.workspace-update', '.manifest.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
