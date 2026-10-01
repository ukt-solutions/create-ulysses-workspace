#!/usr/bin/env node
// Unit tests for migrate-claude-md-freshness-include.mjs
// Run: node template/_claude/scripts/migrate-claude-md-freshness-include.test.mjs
import { runMigration } from './migrate-claude-md-freshness-include.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function assertTrue(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-md-mig-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Run the script as a CLI. `scriptPath` lets tests point at a copy nested in
// a payload-like location; `cwd` and `args` control invocation.
function runCli(scriptPath, { cwd, args = [] }) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf-8' });
}

console.log('# migrate-claude-md-freshness-include');

// CLAUDE.md missing → no-op
withTemp((dir) => {
  const result = runMigration({ workspaceRoot: dir });
  assertEq(result.action, 'skipped', 'no CLAUDE.md is skipped');
});

// CLAUDE.md missing the include → appended
withTemp((dir) => {
  const path = join(dir, 'CLAUDE.md');
  writeFileSync(path, '# Workspace\n@workspace.json\n');
  const result = runMigration({ workspaceRoot: dir });
  assertEq(result.action, 'appended', 'missing line is appended');
  const after = readFileSync(path, 'utf-8');
  assertEq(after.includes('@local-only-template-freshness.md'), true, 'line present after migration');
});

// CLAUDE.md already has the include → no-op
withTemp((dir) => {
  const path = join(dir, 'CLAUDE.md');
  const original = '# Workspace\n@workspace.json\n@local-only-template-freshness.md\n';
  writeFileSync(path, original);
  const result = runMigration({ workspaceRoot: dir });
  assertEq(result.action, 'unchanged', 'already-present line is unchanged');
  assertEq(readFileSync(path, 'utf-8'), original, 'file content unchanged');
});

// CLI: run from a payload-like nested location with --root at the workspace.
// The script must never derive the workspace root from its own path — the
// upgrade payload executes it from <workspace>/.workspace-update/.claude/scripts/.
withTemp((dir) => {
  const workspace = join(dir, 'workspace');
  const payloadScripts = join(dir, 'workspace', '.workspace-update', '.claude', 'scripts');
  mkdirSync(payloadScripts, { recursive: true });
  const nestedScript = join(payloadScripts, 'migrate-claude-md-freshness-include.mjs');
  copyFileSync(join(here, 'migrate-claude-md-freshness-include.mjs'), nestedScript);

  // A decoy CLAUDE.md beside the script (inside the payload) must stay untouched.
  writeFileSync(join(payloadScripts, '..', '..', 'CLAUDE.md'), 'payload decoy\n');
  writeFileSync(join(workspace, 'CLAUDE.md'), '# Workspace\n@workspace.json\n');

  const r = runCli(nestedScript, { cwd: tmpdir(), args: ['--root', workspace] });
  assertEq(r.status, 0, 'CLI exits 0 from nested location');
  assertEq(JSON.parse(r.stdout).action, 'appended', 'CLI reports appended');
  assertTrue(
    readFileSync(join(workspace, 'CLAUDE.md'), 'utf-8').includes('@local-only-template-freshness.md'),
    'include appended to the workspace CLAUDE.md named by --root',
  );
  assertEq(
    readFileSync(join(payloadScripts, '..', '..', 'CLAUDE.md'), 'utf-8'),
    'payload decoy\n',
    'payload-side decoy CLAUDE.md untouched',
  );
});

// CLI: without --root, the workspace root is the cwd — not the script's dir.
withTemp((dir) => {
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'CLAUDE.md'), '# Workspace\n');
  // The script sits elsewhere entirely; cwd is what counts.
  // A CLAUDE.md beside the script's own tree (present in an installed workspace,
  // absent in the package) must come out byte-identical — it is not the target.
  const scriptSide = join(here, "..", "..", "CLAUDE.md");
  const scriptSideBefore = existsSync(scriptSide) ? readFileSync(scriptSide, "utf-8") : null;
  const r = runCli(join(here, 'migrate-claude-md-freshness-include.mjs'), { cwd: workspace });
  assertEq(r.status, 0, 'CLI exits 0 with cwd default');
  assertEq(JSON.parse(r.stdout).action, 'appended', 'cwd default finds the workspace CLAUDE.md');
  assertTrue(
    readFileSync(join(workspace, 'CLAUDE.md'), 'utf-8').includes('@local-only-template-freshness.md'),
    'cwd CLAUDE.md migrated',
  );
  assertEq(
    existsSync(scriptSide) ? readFileSync(scriptSide, 'utf-8') : null,
    scriptSideBefore,
    'script-relative root not used',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
