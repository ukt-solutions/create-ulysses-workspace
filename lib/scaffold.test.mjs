#!/usr/bin/env node
// End-to-end test for scaffold.mjs
// Run: node lib/scaffold.test.mjs
//
// The template stores .gitignore, .claude/, and .mcp.json under the inert
// names _gitignore, _claude/, and _mcp.json (Claude Code protects the live
// names from headless edits). scaffold() must install every one under its
// live name and leave no inert leftovers behind.
import { scaffold } from './scaffold.mjs';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let failed = 0;
let passed = 0;
function check(label, ok) {
  if (ok) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

const directory = mkdtempSync(join(tmpdir(), 'scaffold-test-'));

try {
  await scaffold({
    name: 'demo',
    directory,
    repos: [],
    userName: 'tester',
    activateRules: [],
  });

  // Live names installed
  check('.claude/ directory installed', existsSync(join(directory, '.claude')));
  check('.claude/settings.json installed', existsSync(join(directory, '.claude', 'settings.json')));
  check('.claude/settings.local.json written', existsSync(join(directory, '.claude', 'settings.local.json')));
  check('.claude/rules/ installed', existsSync(join(directory, '.claude', 'rules')));
  check('.claude/rules/coherent-revisions.md installed', existsSync(join(directory, '.claude', 'rules', 'coherent-revisions.md')));
  check('.mcp.json installed', existsSync(join(directory, '.mcp.json')));
  check('.gitignore installed', existsSync(join(directory, '.gitignore')));

  // .mcp.json is the template's payload, unmodified
  const mcp = JSON.parse(readFileSync(join(directory, '.mcp.json'), 'utf8'));
  check('.mcp.json parses with mcpServers object', typeof mcp.mcpServers === 'object' && mcp.mcpServers !== null);

  // Inert names are gone
  check('no _claude/ leftover', !existsSync(join(directory, '_claude')));
  check('no _mcp.json leftover', !existsSync(join(directory, '_mcp.json')));
  check('no _gitignore leftover', !existsSync(join(directory, '_gitignore')));

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
} finally {
  rmSync(directory, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
