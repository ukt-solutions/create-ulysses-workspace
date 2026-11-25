#!/usr/bin/env node
// Test for init.mjs (--init scaffolding)
// Run: node lib/init.test.mjs
//
// --init stages the template payload, installs the bootstrap skills plus
// hooks/scripts/lib, and must leave a template baseline behind: the sha256 of
// every verbatim payload file, so the first /workspace-update classifies
// three ways instead of treating every template change as a local edit
// (gh:183). It must also create the canonical directory at
// workspace-context/shared/locked/ — the path build-workspace-context.mjs
// reads — and not workspace-context/locked/, which nothing reads.
import { initWorkspace } from './init.mjs';
import { hashBytes } from '../template/_claude/scripts/template-baseline.mjs';
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
// The baseline's own content hash — CRLF normalized to LF for text files —
// so the entry is compared with the installed file the way classification
// compares it. A Windows autocrlf checkout installs the same file with
// CRLF, and a raw byte hash would read that as a mismatch.
const sha = (p) => hashBytes(readFileSync(p));

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
    'entry hash matches the installed file',
    baseline.files['.claude/scripts/classify-update.mjs'] === sha(join(root, '.claude', 'scripts', 'classify-update.mjs')),
  );
  check(
    'the installed file is a byte-for-byte copy of the template',
    readFileSync(join(root, '.claude', 'scripts', 'classify-update.mjs')).equals(
      readFileSync(join(here, '..', 'template', '_claude', 'scripts', 'classify-update.mjs')),
    ),
  );
  check(
    'baseline never covers tests (the tarball ships none)',
    Object.keys(baseline.files).every((k) => !k.endsWith('.test.mjs')),
  );
  check(
    'baseline never covers machine-local files',
    !('.claude/settings.local.json' in baseline.files) && !('.claude/.active-session.json' in baseline.files),
  );

  // --init leaves .mcp.json to Step 5 of /workspace-init. An existing project
  // may already carry its own, so the file is installed with the user's yes
  // (lib/workspace-init.test.mjs covers that step).
  check(
    '.mcp.json is staged for /workspace-init, not installed',
    existsSync(join(root, '.workspace-update', '.mcp.json')) && !existsSync(join(root, '.mcp.json')),
  );

  // Canonical directory: where build-workspace-context.mjs reads from
  check('workspace-context/shared/locked/ created', existsSync(join(root, 'workspace-context', 'shared', 'locked')));
  check('workspace-context/locked/ not created', !existsSync(join(root, 'workspace-context', 'locked')));
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
