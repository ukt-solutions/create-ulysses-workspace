#!/usr/bin/env node
// Unit tests for build-workspace-context.mjs
// Run: node template/.claude/scripts/build-workspace-context.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildSharedIndex,
  renderSharedIndex,
  buildCanonical,
  renderCanonical,
  buildTeamMemberIndex,
  renderTeamMemberIndex,
  listTeamMembers,
  regenerateAll,
  fingerprint,
  readDescription,
  stripFrontmatter,
} from './build-workspace-context.mjs';

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
  const root = mkdtempSync(join(tmpdir(), 'wc-test-'));
  mkdirSync(join(root, 'workspace-context', 'shared', 'locked'), { recursive: true });
  mkdirSync(join(root, 'workspace-context', 'team-member'), { recursive: true });
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function gitInit(root) {
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
}

console.log('# readDescription priority');

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'with-fm.md'),
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
  const desc = readDescription(join(root, 'workspace-context', 'shared', 'with-fm.md'));
  assertEq(desc, 'Frontmatter description wins.', 'frontmatter description preferred');
  cleanup(root);
}

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'no-fm-desc.md'),
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
  const desc = readDescription(join(root, 'workspace-context', 'shared', 'no-fm-desc.md'));
  assertEq(desc, 'This is the first paragraph that should be used.', 'first sentence fallback');
  cleanup(root);
}

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'no-frontmatter.md'),
    `# Bare File

Content without frontmatter at all.
`,
  );
  const desc = readDescription(join(root, 'workspace-context', 'shared', 'no-frontmatter.md'));
  assertEq(desc, 'Content without frontmatter at all.', 'works without frontmatter');
  cleanup(root);
}

{
  const root = setupFixture();
  writeFileSync(join(root, 'workspace-context', 'shared', 'empty-body.md'), `---
type: index
---
`);
  const desc = readDescription(join(root, 'workspace-context', 'shared', 'empty-body.md'));
  assertEq(desc, 'empty body', 'filename slug fallback');
  cleanup(root);
}

{
  // prefix-stripping: braindump_/handoff_/research_ removed from filename fallback
  const root = setupFixture();
  writeFileSync(join(root, 'workspace-context', 'shared', 'braindump_topic-x.md'), `---
type: braindump
---
`);
  const desc = readDescription(join(root, 'workspace-context', 'shared', 'braindump_topic-x.md'));
  assertEq(desc, 'topic x', 'braindump_ prefix stripped from slug fallback');
  cleanup(root);
}

console.log('# stripFrontmatter');

{
  const out = stripFrontmatter(`---
type: reference
---

body content here
`);
  assertEq(out.trimEnd(), 'body content here', 'frontmatter stripped');
}

{
  const out = stripFrontmatter('no frontmatter here\n');
  assertEq(out, 'no frontmatter here\n', 'pass-through when no frontmatter');
}

{
  // unterminated frontmatter — return as-is rather than corrupt the file
  const input = `---
type: reference
no closing fence
`;
  assertEq(stripFrontmatter(input), input, 'unterminated frontmatter passes through');
}

console.log('# buildSharedIndex grouping & sort');

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'project-status.md'),
    `---
description: Project status here.
---

body
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'naming.md'),
    `---
description: Naming convention.
---

body
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'inventory.md'),
    `---
description: Top-level inventory.
---

body
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'braindump_idea.md'),
    `---
description: Captured idea.
---

body
`,
  );

  const entries = buildSharedIndex(root);
  assertEq(entries.length, 4, '4 shared entries');
  assertEq(entries[0].isLocked, true, 'locked first');
  assertEq(entries[0].rel, 'shared/locked/naming.md', 'alphabetical within locked (naming before project)');
  assertEq(entries[1].rel, 'shared/locked/project-status.md', 'second locked entry');
  assertEq(entries[2].isLocked, false, 'shared (non-locked) after locked');
  assertEq(entries[2].rel, 'shared/braindump_idea.md', 'alphabetical within shared');
  assertEq(entries[3].rel, 'shared/inventory.md', 'second shared entry');

  cleanup(root);
}

{
  // index.md and canonical.md exclude themselves from the index
  const root = setupFixture();
  writeFileSync(join(root, 'workspace-context', 'index.md'), '---\ntype: index\n---\n');
  writeFileSync(join(root, 'workspace-context', 'canonical.md'), '---\ntype: canonical\n---\n');
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'real.md'),
    `---
description: Real file.
---
body
`,
  );
  const entries = buildSharedIndex(root);
  assertEq(entries.length, 1, 'auto-gens not counted');
  assertEq(entries[0].rel, 'shared/real.md', 'only real shared file');
  cleanup(root);
}

{
  // missing shared/ dir → empty list, no crash
  const root = mkdtempSync(join(tmpdir(), 'wc-empty-'));
  mkdirSync(join(root, 'workspace-context'), { recursive: true });
  const entries = buildSharedIndex(root);
  assertEq(entries, [], 'no shared/ dir yields empty entries');
  cleanup(root);
}

console.log('# .indexignore prefix excludes');

{
  const root = setupFixture();
  mkdirSync(join(root, 'workspace-context', 'shared', 'archived'), { recursive: true });
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'live.md'),
    `---
description: Live.
---
body
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'archived', 'old.md'),
    `---
description: Old.
---
body
`,
  );
  writeFileSync(
    join(root, 'workspace-context', '.indexignore'),
    'shared/archived/\n# comment\n\n',
  );
  const entries = buildSharedIndex(root);
  assertEq(entries.length, 1, 'archived prefix excluded');
  assertEq(entries[0].rel, 'shared/live.md', 'only live.md survives');
  cleanup(root);
}

console.log('# .gitignore filtering');

{
  // local-only-* gitignored at workspace root → filtered out
  const root = setupFixture();
  gitInit(root);
  writeFileSync(join(root, '.gitignore'), 'local-only-*\n');
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'local-only-draft.md'),
    `---
description: Draft.
---
body
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'public.md'),
    `---
description: Public.
---
body
`,
  );
  const entries = buildSharedIndex(root);
  assertEq(entries.length, 1, 'gitignored local-only-* excluded');
  assertEq(entries[0].rel, 'shared/public.md', 'only public file survives');
  cleanup(root);
}

{
  // non-git workspace still works (no filter applied)
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'a.md'),
    `---
description: A.
---
body
`,
  );
  const entries = buildSharedIndex(root);
  assertEq(entries.length, 1, 'non-git workspace still works');
  cleanup(root);
}

console.log('# renderSharedIndex output');

{
  const entries = [
    { rel: 'shared/locked/a.md', isLocked: true, description: 'A.' },
    { rel: 'shared/b.md', isLocked: false, description: 'B.' },
  ];
  const out = renderSharedIndex(entries, '2026-04-27T00:00:00Z');
  assert(out.includes('## Canonical (in CLAUDE.md context verbatim)'), 'has canonical heading');
  assert(out.includes('## Shared'), 'has shared heading');
  assert(out.includes('- [shared/locked/a.md](shared/locked/a.md) — A.'), 'locked entry rendered');
  assert(out.includes('- [shared/b.md](shared/b.md) — B.'), 'shared entry rendered');
  assert(out.includes('generated: 2026-04-27T00:00:00Z'), 'frontmatter has generated timestamp');
}

{
  const out = renderSharedIndex([], '2026-04-27T00:00:00Z');
  assert(out.includes('_(no shared workspace-context files yet)_'), 'empty state rendered');
}

{
  // only-locked: no Shared heading
  const out = renderSharedIndex(
    [{ rel: 'shared/locked/x.md', isLocked: true, description: 'X.' }],
    '2026-04-27T00:00:00Z',
  );
  assert(out.includes('## Canonical'), 'canonical heading present');
  assert(!out.includes('## Shared'), 'no shared heading when no non-locked entries');
}

console.log('# buildCanonical concat');

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'a-naming.md'),
    `---
type: reference
description: Naming.
---

# Naming

Use kebab-case.
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'b-status.md'),
    `---
type: reference
description: Status.
---

# Status

Beta.
`,
  );
  const items = buildCanonical(root);
  assertEq(items.length, 2, '2 canonical items');
  assertEq(items[0].name, 'a-naming', 'sorted alphabetically');
  assert(items[0].content.includes('Use kebab-case.'), 'frontmatter stripped, body preserved');
  assert(!items[0].content.startsWith('---'), 'no frontmatter in concat output');
  cleanup(root);
}

{
  // missing locked/ dir → empty list
  const root = mkdtempSync(join(tmpdir(), 'wc-no-locked-'));
  mkdirSync(join(root, 'workspace-context', 'shared'), { recursive: true });
  const items = buildCanonical(root);
  assertEq(items, [], 'no locked/ dir yields empty canonical');
  cleanup(root);
}

console.log('# renderCanonical output');

{
  const items = [
    { name: 'naming', content: 'Use kebab-case.' },
    { name: 'status', content: 'Beta.' },
  ];
  const out = renderCanonical(items, '2026-04-27T00:00:00Z');
  assert(out.includes('## naming'), 'section header from name');
  assert(out.includes('## status'), 'second section header');
  assert(out.includes('Use kebab-case.'), 'body included');
  assert(out.includes('type: canonical'), 'frontmatter type set');
}

{
  const out = renderCanonical([], '2026-04-27T00:00:00Z');
  assert(out.includes('_(no canonical entries yet'), 'empty state rendered');
}

console.log('# buildTeamMemberIndex per-user');

{
  const root = setupFixture();
  mkdirSync(join(root, 'workspace-context', 'team-member', 'alice'), { recursive: true });
  writeFileSync(
    join(root, 'workspace-context', 'team-member', 'alice', 'index.md'),
    '---\ntype: index\n---\n',
  );
  writeFileSync(
    join(root, 'workspace-context', 'team-member', 'alice', 'braindump_thoughts.md'),
    `---
description: Some thoughts.
---
body
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'team-member', 'alice', 'handoff_proj.md'),
    `---
description: Project handoff.
---
body
`,
  );
  const entries = buildTeamMemberIndex(root, 'alice');
  assertEq(entries.length, 2, 'index.md excluded, two entries remain');
  assertEq(entries[0].rel, 'braindump_thoughts.md', 'alphabetical, paths relative to user dir');
  assertEq(entries[1].rel, 'handoff_proj.md', 'second entry');
  cleanup(root);
}

{
  // gitignore still applies under team-member/
  const root = setupFixture();
  gitInit(root);
  writeFileSync(join(root, '.gitignore'), 'local-only-*\n');
  mkdirSync(join(root, 'workspace-context', 'team-member', 'bob'), { recursive: true });
  writeFileSync(
    join(root, 'workspace-context', 'team-member', 'bob', 'local-only-draft.md'),
    `---
description: Local.
---
body
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'team-member', 'bob', 'shared-thought.md'),
    `---
description: Shareable.
---
body
`,
  );
  const entries = buildTeamMemberIndex(root, 'bob');
  assertEq(entries.length, 1, 'gitignored local-only-* excluded from per-user index');
  assertEq(entries[0].rel, 'shared-thought.md', 'public file survives');
  cleanup(root);
}

{
  // missing user dir → []
  const root = setupFixture();
  const entries = buildTeamMemberIndex(root, 'ghost');
  assertEq(entries, [], 'missing user dir yields empty');
  cleanup(root);
}

console.log('# renderTeamMemberIndex output');

{
  const out = renderTeamMemberIndex(
    'alice',
    [{ rel: 'braindump_x.md', description: 'X.' }],
    '2026-04-27T00:00:00Z',
  );
  assert(out.includes("# alice's context"), 'user-specific heading');
  assert(out.includes('- [braindump_x.md](braindump_x.md) — X.'), 'entry rendered');
}

{
  const out = renderTeamMemberIndex('alice', [], '2026-04-27T00:00:00Z');
  assert(out.includes('_(no personal context files yet)_'), 'empty state rendered');
}

console.log('# listTeamMembers');

{
  const root = setupFixture();
  mkdirSync(join(root, 'workspace-context', 'team-member', 'alice'), { recursive: true });
  mkdirSync(join(root, 'workspace-context', 'team-member', 'bob'), { recursive: true });
  // file at team-member/ level should be ignored (not a dir)
  writeFileSync(join(root, 'workspace-context', 'team-member', 'README.md'), '# readme\n');
  const users = listTeamMembers(root);
  assertEq(users, ['alice', 'bob'], 'sorted user dirs only');
  cleanup(root);
}

{
  // missing team-member/ → []
  const root = mkdtempSync(join(tmpdir(), 'wc-no-tm-'));
  mkdirSync(join(root, 'workspace-context'), { recursive: true });
  const users = listTeamMembers(root);
  assertEq(users, [], 'no team-member dir yields empty');
  cleanup(root);
}

console.log('# regenerateAll orchestration');

{
  const root = setupFixture();
  mkdirSync(join(root, 'workspace-context', 'team-member', 'alice'), { recursive: true });
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'naming.md'),
    `---
description: Naming.
---
body
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'team-member', 'alice', 'note.md'),
    `---
description: Note.
---
body
`,
  );
  const out = regenerateAll(root, '2026-04-27T00:00:00Z');
  assertEq(out.length, 3, '3 artifacts: index, canonical, alice/index');
  assertEq(out[0].label, 'index.md', 'index first');
  assertEq(out[1].label, 'canonical.md', 'canonical second');
  assertEq(out[2].label, 'team-member/alice/index.md', 'per-user third');
  cleanup(root);
}

{
  // missing workspace-context root → no artifacts (no crash)
  const root = mkdtempSync(join(tmpdir(), 'wc-bare-'));
  const out = regenerateAll(root, '2026-04-27T00:00:00Z');
  assertEq(out, [], 'missing wcRoot yields empty plan');
  cleanup(root);
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
generated: 2026-04-27T00:00:00Z
---

body one
`;
  const b = `---
generated: 2026-04-27T00:00:00Z
---

body two
`;
  assert(fingerprint(a) !== fingerprint(b), 'different body → different fingerprint');
}

console.log('# CLI --check / --write end-to-end');

{
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'rule.md'),
    `---
description: Rule.
---
body
`,
  );

  const scriptPath = new URL('./build-workspace-context.mjs', import.meta.url).pathname;

  // --check should report stale (or missing — index/canonical not yet on disk)
  const check1 = spawnSync('node', [scriptPath, '--check', '--root', root], { encoding: 'utf-8' });
  assertEq(check1.status, 1, '--check exits 1 when artifacts missing');
  const check1Out = JSON.parse(check1.stdout);
  assertEq(check1Out.status, 'stale', '--check reports stale');
  assert(check1Out.missing.includes('index.md'), 'index.md flagged missing');
  assert(check1Out.missing.includes('canonical.md'), 'canonical.md flagged missing');

  // --write generates them
  const write = spawnSync('node', [scriptPath, '--write', '--root', root], { encoding: 'utf-8' });
  assertEq(write.status, 0, '--write exits 0');
  const writeOut = JSON.parse(write.stdout);
  assertEq(writeOut.status, 'written', '--write reports written');

  // --check now passes
  const check2 = spawnSync('node', [scriptPath, '--check', '--root', root], { encoding: 'utf-8' });
  assertEq(check2.status, 0, '--check exits 0 after --write');

  cleanup(root);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
