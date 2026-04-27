#!/usr/bin/env node
// Unit tests for migrate-to-workspace-context.mjs
// Run: node template/.claude/scripts/migrate-to-workspace-context.test.mjs

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrate, dirLooksLikeUserScope } from './migrate-to-workspace-context.mjs';

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function setupGitRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mig-test-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  // Install the generator and capture-context scripts so step12 can run
  mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
  mkdirSync(join(root, '.claude', 'lib'), { recursive: true });
  cpSync(
    new URL('./build-workspace-context.mjs', import.meta.url).pathname,
    join(root, '.claude', 'scripts', 'build-workspace-context.mjs'),
  );
  cpSync(
    new URL('./generate-claude-local.mjs', import.meta.url).pathname,
    join(root, '.claude', 'scripts', 'generate-claude-local.mjs'),
  );
  cpSync(
    new URL('../lib/session-frontmatter.mjs', import.meta.url).pathname,
    join(root, '.claude', 'lib', 'session-frontmatter.mjs'),
  );
  // Configure user for CLAUDE.local.md generation
  writeFileSync(
    join(root, '.claude', 'settings.local.json'),
    JSON.stringify({ workspace: { user: 'alice' } }),
  );
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function writeFM(path, fm, body = 'body\n') {
  mkdirSync(dirname(path), { recursive: true });
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(path, `---\n${yaml}\n---\n\n${body}`);
}

function gitAddCommit(root) {
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root });
}

function summarize(results) {
  return Object.fromEntries(results.map((r) => [r.name, r.status]));
}

console.log('# fresh template (no shared-context, no release-notes)');

{
  const root = setupGitRoot();
  // Just CLAUDE.md and workspace.json present
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# Fresh\n\n## Workspace Config\n@workspace.json\n',
  );
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({ workspace: { name: 'fresh' } }, null, 2) + '\n',
  );
  gitAddCommit(root);

  const results = migrate(root);
  const s = summarize(results);
  assertEq(s['rename-shared-context'], 'noop', 'no shared-context to migrate');
  assertEq(s['consolidate-locked'], 'noop', 'noop on fresh');
  assertEq(s['move-release-notes'], 'noop', 'no release-notes to move');
  // No source dirs, but workspace.json still gets the new fields
  assertEq(s['update-workspace-json'], 'applied', 'workspace.json gets workspaceContextDir');
  cleanup(root);
}

console.log('# full migration of pre-v0.15 layout');

{
  const root = setupGitRoot();
  // Old layout
  writeFM(
    join(root, OLD_FILE('locked', 'naming.md')),
    { state: 'locked', type: 'reference', topic: 'naming' },
    '# Naming\n',
  );
  writeFM(
    join(root, OLD_FILE('inventory.md')),
    { state: 'ephemeral', type: 'reference', description: 'Inventory.' },
    '# Inventory\n',
  );
  writeFM(
    join(root, OLD_FILE('alice', 'mythoughts.md')),
    { state: 'ephemeral', type: 'braindump', topic: 'mythoughts', author: 'alice' },
    '# Thoughts\n',
  );
  writeFM(
    join(root, OLD_FILE('product-x', 'feature-design.md')),
    { state: 'ephemeral', type: 'design', description: 'Feature design.' },
    'design\n',
  );
  // release-notes at root
  mkdirSync(join(root, 'release-notes', 'unreleased'), { recursive: true });
  writeFileSync(
    join(root, 'release-notes', 'unreleased', 'note.md'),
    '## Note\n',
  );
  // CLAUDE.md with broken import
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# Workspace\n\n## Team Knowledge (always loaded)\n@shared-context/locked/\n',
  );
  // workspace.json with old field
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace: {
        name: 'demo',
        sharedContextDir: 'shared-context',
        releaseNotesDir: 'release-notes',
      },
    }, null, 2) + '\n',
  );
  // .indexignore with legacy header
  writeFileSync(
    join(root, OLD_FILE('.indexignore')),
    '# Shared-context paths excluded from shared-context/index.md.\nscaffolder-release-history/\n',
  );
  gitAddCommit(root);

  const results = migrate(root);
  const s = summarize(results);

  // Step 1
  assertEq(s['rename-shared-context'], 'applied', 'shared-context renamed');
  assert(existsSync(join(root, 'workspace-context')), 'workspace-context dir present');
  assert(!existsSync(join(root, 'shared-context')), 'shared-context dir gone');

  // Step 2: locked moved into shared/
  assert(
    existsSync(join(root, 'workspace-context', 'shared', 'locked', 'naming.md')),
    'locked file under shared/locked/',
  );

  // Step 3: root .md moved into shared/
  assert(
    existsSync(join(root, 'workspace-context', 'shared', 'inventory.md')),
    'root md moved to shared/',
  );

  // Step 4: alice (user dir, has author: alice) → team-member/alice/
  assert(
    existsSync(join(root, 'workspace-context', 'team-member', 'alice', 'mythoughts.md'))
      // post-step5 it may be renamed to braindump_mythoughts.md; check both
      || existsSync(join(root, 'workspace-context', 'team-member', 'alice', 'braindump_mythoughts.md')),
    'alice dir → team-member/alice/',
  );
  // product-x (no author match) → shared/product-x/
  assert(
    existsSync(join(root, 'workspace-context', 'shared', 'product-x', 'feature-design.md')),
    'product-x dir → shared/product-x/',
  );

  // Step 5: braindump file got prefixed
  assert(
    existsSync(join(root, 'workspace-context', 'team-member', 'alice', 'braindump_mythoughts.md')),
    'braindump_ prefix applied',
  );

  // Step 6: release-notes moved
  assert(
    existsSync(join(root, 'workspace-context', 'release-notes', 'unreleased', 'note.md')),
    'release-notes moved under workspace-context/',
  );
  assert(!existsSync(join(root, 'release-notes')), 'old release-notes/ gone');

  // Step 7: CLAUDE.md updated
  const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
  assert(claudeMd.includes('@workspace-context/canonical.md'), 'CLAUDE.md imports canonical');
  assert(claudeMd.includes('@workspace-context/index.md'), 'CLAUDE.md imports index');
  assert(!claudeMd.includes('@shared-context/locked/'), 'broken import gone');

  // Step 8: workspace.json
  const ws = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf-8'));
  assertEq(ws.workspace.workspaceContextDir, 'workspace-context', 'workspaceContextDir set');
  assert(!('sharedContextDir' in ws.workspace), 'sharedContextDir removed');
  assertEq(ws.workspace.releaseNotesDir, 'workspace-context/release-notes', 'releaseNotesDir updated');

  // Step 9: .indexignore
  const ii = readFileSync(join(root, 'workspace-context', '.indexignore'), 'utf-8');
  assert(ii.includes('workspace-context'), '.indexignore header updated');
  // scaffolder-release-history/ stays at workspace-context root (it's reserved),
  // so its .indexignore entry stays as a bare prefix relative to workspace-context/
  assert(ii.includes('scaffolder-release-history/'), 'scaffolder entry preserved');
  assert(!ii.includes('shared/scaffolder-release-history/'), 'no incorrect prefix-shift');
  assert(ii.includes('release-notes/'), 'release-notes/ added');

  // Step 10: CLAUDE.local.md
  assert(existsSync(join(root, 'CLAUDE.local.md')), 'CLAUDE.local.md generated');
  const local = readFileSync(join(root, 'CLAUDE.local.md'), 'utf-8');
  assert(local.includes('alice/index.md'), 'CLAUDE.local.md has alice import');

  // Step 12: auto-files exist
  assert(existsSync(join(root, 'workspace-context', 'index.md')), 'index.md generated');
  assert(existsSync(join(root, 'workspace-context', 'canonical.md')), 'canonical.md generated');

  cleanup(root);
}

console.log('# idempotence: re-running migration is a no-op');

{
  const root = setupGitRoot();
  writeFM(
    join(root, OLD_FILE('locked', 'rule.md')),
    { state: 'locked', type: 'reference' },
    '# Rule\n',
  );
  writeFileSync(join(root, 'CLAUDE.md'), '@shared-context/locked/\n');
  writeFileSync(join(root, 'workspace.json'),
    JSON.stringify({ workspace: { sharedContextDir: 'shared-context' } }, null, 2) + '\n',
  );
  gitAddCommit(root);

  const first = migrate(root);
  const firstApplied = first.filter((r) => r.status === 'applied').map((r) => r.name);
  assert(firstApplied.length > 0, 'first run applied changes');

  // Commit the migration so step5 can re-mv files
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'migrated'], { cwd: root });

  const second = migrate(root);
  const secondApplied = second.filter((r) => r.status === 'applied').map((r) => r.name);
  // Step 12 re-runs the generator (it always applies if outputs differ from disk).
  // Anything else applied a second time is a bug.
  for (const name of secondApplied) {
    assert(name === 'build-auto-files', `step "${name}" should be idempotent`);
  }
  cleanup(root);
}

console.log('# dirLooksLikeUserScope heuristic');

{
  const root = mkdtempSync(join(tmpdir(), 'mig-uscope-'));
  // alice/ has a file with author: alice
  mkdirSync(join(root, 'alice'), { recursive: true });
  writeFM(
    join(root, 'alice', 'note.md'),
    { type: 'braindump', author: 'alice' },
  );
  // bob/ has files but author is unknown
  mkdirSync(join(root, 'bob'), { recursive: true });
  writeFM(
    join(root, 'bob', 'design.md'),
    { type: 'design' },
  );
  // empty dir
  mkdirSync(join(root, 'empty'), { recursive: true });

  assert(dirLooksLikeUserScope(join(root, 'alice'), 'alice'), 'alice dir detected as user');
  assert(!dirLooksLikeUserScope(join(root, 'bob'), 'bob'), 'bob dir not detected as user');
  assert(!dirLooksLikeUserScope(join(root, 'empty'), 'empty'), 'empty dir not detected');
  cleanup(root);
}

console.log('# project repo (no release-notes/, no shared-context/)');

{
  const root = setupGitRoot();
  writeFileSync(join(root, 'CLAUDE.md'), '# Project\n');
  writeFileSync(join(root, 'workspace.json'),
    JSON.stringify({ workspace: { name: 'p' } }, null, 2) + '\n',
  );
  gitAddCommit(root);
  const results = migrate(root);
  const s = summarize(results);
  // No source content to migrate
  assertEq(s['rename-shared-context'], 'noop');
  assertEq(s['move-release-notes'], 'noop');
  // No errors
  for (const r of results) assert(r.status !== 'error', `step ${r.name} did not error`);
  cleanup(root);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

// helpers

function OLD_FILE(...parts) {
  return join('shared-context', ...parts);
}
