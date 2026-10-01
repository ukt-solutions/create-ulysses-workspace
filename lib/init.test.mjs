#!/usr/bin/env node
// Test for init.mjs (--init scaffolding)
// Run: node lib/init.test.mjs
//
// --init stages the template payload, installs the bootstrap skills plus
// hooks/scripts/lib, and must leave a template baseline behind: the sha256 of
// every verbatim payload file, so the first /workspace-update classifies
// three ways instead of treating every template change as a local edit
// (gh:183).
import { initWorkspace } from './init.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
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
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const root = mkdtempSync(join(tmpdir(), 'init-test-'));

try {
  await initWorkspace(root);

  const baselinePath = join(root, '.claude', '.template-baseline.json');
  check('baseline written at .claude/.template-baseline.json', existsSync(baselinePath));
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

  check(`baseline records the payload version (${pkgVersion})`, baseline.templateVersion === pkgVersion);
  check(
    'baseline covers the bootstrap skills --init installs',
    typeof baseline.files['.claude/skills/workspace-update/SKILL.md'] === 'string'
      && typeof baseline.files['.claude/skills/workspace-init/SKILL.md'] === 'string',
  );
  check(
    'baseline covers hooks and scripts',
    typeof baseline.files['.claude/hooks/session-start.mjs'] === 'string'
      && typeof baseline.files['.claude/scripts/classify-update.mjs'] === 'string',
  );
  check(
    'baseline covers the standalone verbatim files',
    typeof baseline.files['.mcp.json'] === 'string' && typeof baseline.files['.claudeignore'] === 'string',
  );
  check(
    'entry hash matches the installed file byte-for-byte',
    baseline.files['.claude/scripts/classify-update.mjs'] === sha(join(root, '.claude', 'scripts', 'classify-update.mjs')),
  );
  check(
    'baseline never covers tests (the tarball ships none)',
    Object.keys(baseline.files).every((k) => !k.endsWith('.test.mjs')),
  );
  check(
    'baseline never covers machine-local files',
    !('.claude/settings.local.json' in baseline.files) && !('.claude/.active-session.json' in baseline.files),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
