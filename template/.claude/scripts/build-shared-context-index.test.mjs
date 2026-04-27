#!/usr/bin/env node
// Unit tests for build-shared-context-index.mjs
// Run: node template/.claude/scripts/build-shared-context-index.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildEntries, renderIndex, fingerprint, readDescription } from './build-shared-context-index.mjs';

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

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sc-index-test-'));
  mkdirSync(join(root, 'shared-context'), { recursive: true });
  mkdirSync(join(root, 'shared-context', 'locked'), { recursive: true });
  mkdirSync(join(root, 'shared-context', 'alice'), { recursive: true });
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

console.log('# readDescription priority');

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'shared-context', 'with-fm.md'),
    `---
state: locked
type: reference
description: Frontmatter description wins.
updated: 2026-04-25
---

# Title

This is the body.
`,
  );
  const desc = readDescription(join(root, 'shared-context', 'with-fm.md'));
  assertEq(desc, 'Frontmatter description wins.', 'frontmatter description preferred');
  cleanup(root);
}

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'shared-context', 'no-fm-desc.md'),
    `---
state: ephemeral
type: braindump
updated: 2026-04-25
---

# Some Title

This is the first paragraph that should be used. It has multiple sentences.

This is a second paragraph.
`,
  );
  const desc = readDescription(join(root, 'shared-context', 'no-fm-desc.md'));
  assertEq(desc, 'This is the first paragraph that should be used.', 'first sentence fallback');
  cleanup(root);
}

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'shared-context', 'no-frontmatter.md'),
    `# Bare File

Content without frontmatter at all.
`,
  );
  const desc = readDescription(join(root, 'shared-context', 'no-frontmatter.md'));
  assertEq(desc, 'Content without frontmatter at all.', 'works without frontmatter');
  cleanup(root);
}

{
  const root = setupFixture();
  writeFileSync(join(root, 'shared-context', 'empty-body.md'), `---
type: index
---
`);
  const desc = readDescription(join(root, 'shared-context', 'empty-body.md'));
  assertEq(desc, 'empty body', 'filename slug fallback');
  cleanup(root);
}

console.log('# buildEntries grouping & sort');

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'shared-context', 'locked', 'project-status.md'),
    `---
description: Project status here.
---

body
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'locked', 'naming.md'),
    `---
description: Naming convention.
---

body
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'inventory.md'),
    `---
description: Top-level inventory.
---

body
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'alice', 'notes.md'),
    `---
description: Alice notes.
---

body
`,
  );

  const entries = buildEntries(root);
  assertEq(entries.length, 4, '4 entries');
  assertEq(entries[0].group, 'locked', 'locked first');
  assertEq(entries[0].sortKey, 'naming.md', 'alphabetical within locked (naming before project)');
  assertEq(entries[1].sortKey, 'project-status.md', 'second locked entry');
  assertEq(entries[2].group, '__root__', 'root group second');
  assertEq(entries[3].group, 'alice', 'user dir last');

  cleanup(root);
}

console.log('# renderIndex output');

{
  const entries = [
    { group: 'locked', sortKey: 'a.md', relativePath: 'locked/a.md', description: 'A.' },
    { group: '__root__', sortKey: 'b.md', relativePath: 'b.md', description: 'B.' },
    { group: 'alice', sortKey: 'c.md', relativePath: 'alice/c.md', description: 'C.' },
  ];
  const output = renderIndex(entries, '2026-04-25T00:00:00Z');
  assert(output.includes('## Locked (team truths, always loaded)'), 'has locked heading');
  assert(output.includes('## Team-shared (root)'), 'has team-shared heading');
  assert(output.includes('## alice'), 'has user dir heading');
  assert(output.includes('- [locked/a.md](locked/a.md) — A.'), 'links use relative path');
  assert(output.includes('generated: 2026-04-25T00:00:00Z'), 'frontmatter has generated timestamp');
}

{
  const output = renderIndex([], '2026-04-25T00:00:00Z');
  assert(output.includes('_(no shared-context files yet)_'), 'empty state');
}

console.log('# fingerprint ignores generated line');

{
  const a = `---
type: index
generated: 2026-04-25T00:00:00Z
---

body
`;
  const b = `---
type: index
generated: 2026-04-26T00:00:00Z
---

body
`;
  assertEq(fingerprint(a), fingerprint(b), 'different generated, same body → same fingerprint');
}

{
  const a = `---
generated: 2026-04-25T00:00:00Z
---

body one
`;
  const b = `---
generated: 2026-04-25T00:00:00Z
---

body two
`;
  assert(fingerprint(a) !== fingerprint(b), 'different body → different fingerprint');
}

console.log('# missing shared-context dir');

{
  const root = mkdtempSync(join(tmpdir(), 'sc-index-empty-'));
  const entries = buildEntries(root);
  assertEq(entries, [], 'no shared-context dir yields empty entries');
  cleanup(root);
}

console.log('# .indexignore prefix excludes');

{
  const root = setupFixture();
  mkdirSync(join(root, 'shared-context', 'archive'), { recursive: true });
  writeFileSync(
    join(root, 'shared-context', 'archive', 'old1.md'),
    `---
description: Archived 1.
---
body
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'archive', 'old2.md'),
    `---
description: Archived 2.
---
body
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'live.md'),
    `---
description: Live file.
---
body
`,
  );
  writeFileSync(join(root, 'shared-context', '.indexignore'), 'archive/\n# comment\n\n');

  const entries = buildEntries(root);
  assertEq(entries.length, 1, 'archive/ excluded by .indexignore');
  assertEq(entries[0].relativePath, 'live.md', 'only live.md survives');
  cleanup(root);
}

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'shared-context', 'a.md'),
    `---
description: A.
---
body
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'b.md'),
    `---
description: B.
---
body
`,
  );
  writeFileSync(join(root, 'shared-context', '.indexignore'), 'a.md\n');
  const entries = buildEntries(root);
  assertEq(entries.length, 1, 'specific file excluded by .indexignore');
  assertEq(entries[0].relativePath, 'b.md', 'only b.md survives');
  cleanup(root);
}

console.log('# .gitignore filtering');

function gitInit(root) {
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
}

{
  // local-only-* gitignored at workspace root → filtered from index
  const root = setupFixture();
  gitInit(root);
  writeFileSync(join(root, '.gitignore'), 'local-only-*\n');
  writeFileSync(
    join(root, 'shared-context', 'alice', 'local-only-secret.md'),
    `---
description: Secret personal note.
---
body
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'alice', 'public.md'),
    `---
description: Public team note.
---
body
`,
  );
  const entries = buildEntries(root);
  assertEq(entries.length, 1, 'gitignored local-only-* excluded');
  assertEq(entries[0].relativePath, 'alice/public.md', 'public file survives');
  cleanup(root);
}

{
  // Non-git workspace falls back gracefully (no filter applied)
  const root = setupFixture();
  writeFileSync(
    join(root, 'shared-context', 'a.md'),
    `---
description: A.
---
body
`,
  );
  const entries = buildEntries(root);
  assertEq(entries.length, 1, 'non-git workspace still works');
  cleanup(root);
}

{
  // .indexignore + .gitignore compose — both must be respected
  const root = setupFixture();
  gitInit(root);
  writeFileSync(join(root, '.gitignore'), 'local-only-*\n');
  mkdirSync(join(root, 'shared-context', 'archive'), { recursive: true });
  writeFileSync(join(root, 'shared-context', '.indexignore'), 'archive/\n');
  writeFileSync(
    join(root, 'shared-context', 'archive', 'old.md'),
    `---
description: Archived.
---
body
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'local-only-private.md'),
    `---
description: Local-only.
---
body
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'shared.md'),
    `---
description: Shared.
---
body
`,
  );
  const entries = buildEntries(root);
  assertEq(entries.length, 1, 'both filters compose');
  assertEq(entries[0].relativePath, 'shared.md', 'only shared.md survives');
  cleanup(root);
}

console.log('# index.md is excluded from its own entries');

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'shared-context', 'index.md'),
    `---
type: index
---

# index
`,
  );
  writeFileSync(
    join(root, 'shared-context', 'real.md'),
    `---
description: Real file.
---

body
`,
  );
  const entries = buildEntries(root);
  assertEq(entries.length, 1, 'only the non-index file');
  assertEq(entries[0].relativePath, 'real.md', 'index.md excluded');
  cleanup(root);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
