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
  DEFAULT_CANONICAL_BUDGET,
  readWorkspaceBudget,
  extractCanonicalVariants,
  selectCanonicalContent,
  renderCanonicalBody,
} from './build-workspace-context.mjs';

const NULL_SELECTION = {
  status: 'ok',
  budgetBytes: null,
  currentBytes: 0,
  trimmedFiles: [],
  stubbedFiles: [],
};

function resolvedFromOldShape(items) {
  return items.map((it) => ({ name: it.name, priority: 'critical', content: it.content }));
}

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
  assert(items[0].full.includes('Use kebab-case.'), 'frontmatter stripped, body preserved');
  assert(!items[0].full.startsWith('---'), 'no frontmatter in full variant');
  assertEq(items[0].priority, 'critical', 'priority defaults to critical');
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
  const out = renderCanonical(resolvedFromOldShape(items), NULL_SELECTION, '2026-04-27T00:00:00Z');
  assert(out.includes('## naming'), 'section header from name');
  assert(out.includes('## status'), 'second section header');
  assert(out.includes('Use kebab-case.'), 'body included');
  assert(out.includes('type: canonical'), 'frontmatter type set');
  assert(!out.includes('budget:'), 'no budget frontmatter line when budgetBytes=null');
  assert(!out.includes('Budget:'), 'no budget blockquote when budgetBytes=null');
}

{
  const out = renderCanonical([], NULL_SELECTION, '2026-04-27T00:00:00Z');
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

console.log('# extractCanonicalVariants');

{
  // 1. No markers: full === trimmed === stripped body, stub is breadcrumb form.
  const raw = `---
priority: reference
---

# Hello

This file has no markers.
`;
  const v = extractCanonicalVariants({ name: 'no-markers', rawContent: raw });
  assertEq(v.full, '# Hello\n\nThis file has no markers.', 'full strips frontmatter, no markers to remove');
  assertEq(v.trimmed, v.full, 'trimmed === full when no markers present');
  assertEq(v.stub, '> _Dropped for canonical budget — see `shared/locked/no-markers.md`._', 'stub is one-line breadcrumb');
}

{
  // 2. One trim block: full keeps content, trimmed replaces with breadcrumb, stub is breadcrumb.
  const raw = `---
priority: reference
---

# Header

Always shown.

<!-- canonical:trim -->
Droppable details here.
More droppable text.
<!-- canonical:end-trim -->

Tail content.
`;
  const v = extractCanonicalVariants({ name: 'one-block', rawContent: raw });
  assert(v.full.includes('Droppable details here.'), 'full keeps the wrapped content');
  assert(!v.full.includes('canonical:trim'), 'full strips opener marker');
  assert(!v.full.includes('canonical:end-trim'), 'full strips closer marker');
  assert(v.trimmed.includes('Trimmed for canonical budget'), 'trimmed has breadcrumb');
  assert(!v.trimmed.includes('Droppable details here.'), 'trimmed drops wrapped content');
  assert(v.trimmed.includes('Tail content.'), 'trimmed keeps post-block content');
  assert(v.trimmed.includes('Always shown.'), 'trimmed keeps pre-block content');
  assertEq(v.stub, '> _Dropped for canonical budget — see `shared/locked/one-block.md`._', 'stub form');
}

{
  // 3. Two consecutive trim blocks collapse to one breadcrumb.
  const raw = `---
priority: reference
---

Pre.

<!-- canonical:trim -->
First droppable.
<!-- canonical:end-trim -->
<!-- canonical:trim -->
Second droppable.
<!-- canonical:end-trim -->

Post.
`;
  const v = extractCanonicalVariants({ name: 'two-blocks', rawContent: raw });
  const breadcrumbCount = (v.trimmed.match(/Trimmed for canonical budget/g) || []).length;
  assertEq(breadcrumbCount, 1, 'consecutive trim blocks collapse to one breadcrumb');
  assert(!v.trimmed.includes('First droppable.'), 'first block dropped');
  assert(!v.trimmed.includes('Second droppable.'), 'second block dropped');
}

{
  // 4. Unmatched opener throws.
  const raw = `---
priority: reference
---

Pre.

<!-- canonical:trim -->
No closer here.
`;
  let threw = false;
  try {
    extractCanonicalVariants({ name: 'bad-open', rawContent: raw });
  } catch (e) {
    threw = true;
    assert(/canonical:trim parse error in bad-open/.test(e.message), 'error message names the file');
  }
  assert(threw, 'unmatched opener throws');
}

{
  // 5. Nested opener throws.
  const raw = `---
priority: reference
---

<!-- canonical:trim -->
Outer.
<!-- canonical:trim -->
Inner.
<!-- canonical:end-trim -->
<!-- canonical:end-trim -->
`;
  let threw = false;
  try {
    extractCanonicalVariants({ name: 'nested', rawContent: raw });
  } catch (e) {
    threw = true;
    assert(/nested opener/.test(e.message), 'error message mentions nesting');
  }
  assert(threw, 'nested opener throws');
}

console.log('# readWorkspaceBudget');

{
  // 12. workspace.json missing → default.
  const root = mkdtempSync(join(tmpdir(), 'wc-budget-'));
  assertEq(readWorkspaceBudget(root), DEFAULT_CANONICAL_BUDGET, 'missing workspace.json → default');
  cleanup(root);
}

{
  // 13. Field absent → default.
  const root = mkdtempSync(join(tmpdir(), 'wc-budget-'));
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace: { name: 'x' } }));
  assertEq(readWorkspaceBudget(root), DEFAULT_CANONICAL_BUDGET, 'absent field → default');
  cleanup(root);
}

{
  // 14. Field set to 81920 → 81920.
  const root = mkdtempSync(join(tmpdir(), 'wc-budget-'));
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace: { canonicalBudgetBytes: 81920 } }));
  assertEq(readWorkspaceBudget(root), 81920, 'explicit value returned');
  cleanup(root);
}

{
  // 15. Field is 0 → 0 (disabled).
  const root = mkdtempSync(join(tmpdir(), 'wc-budget-'));
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace: { canonicalBudgetBytes: 0 } }));
  assertEq(readWorkspaceBudget(root), 0, 'zero treated as disabled');
  cleanup(root);
}

{
  // 16. Field is -1 → 0 (disabled).
  const root = mkdtempSync(join(tmpdir(), 'wc-budget-'));
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace: { canonicalBudgetBytes: -1 } }));
  assertEq(readWorkspaceBudget(root), 0, 'negative treated as disabled');
  cleanup(root);
}

{
  // 17. Invalid JSON → default, no throw.
  const root = mkdtempSync(join(tmpdir(), 'wc-budget-'));
  writeFileSync(join(root, 'workspace.json'), '{ not valid json');
  let threw = false;
  let result;
  try { result = readWorkspaceBudget(root); } catch { threw = true; }
  assert(!threw, 'invalid JSON does not throw');
  assertEq(result, DEFAULT_CANONICAL_BUDGET, 'invalid JSON falls back to default');
  cleanup(root);
}

console.log('# selectCanonicalContent');

function makeItem(name, priority, full, trimmed = full, stub = `> _Dropped for canonical budget — see \`shared/locked/${name}.md\`._`) {
  return { name, priority, full, trimmed, stub };
}

const measureBody = { measureBodyBytes: (resolved) => Buffer.byteLength(renderCanonicalBody(resolved), 'utf-8') };

{
  // 6. Total ≤ budget at stage 1: status 'ok'.
  const items = [
    makeItem('a', 'critical', 'short A'),
    makeItem('b', 'reference', 'short B'),
  ];
  const { resolvedItems, selection } = selectCanonicalContent(items, 100000, measureBody);
  assertEq(selection.status, 'ok', 'status ok when fits at stage 1');
  assertEq(resolvedItems[0].content, 'short A', 'critical resolved to full');
  assertEq(resolvedItems[1].content, 'short B', 'reference resolved to full');
  assertEq(selection.trimmedFiles, [], 'no trimmed files at ok');
  assertEq(selection.stubbedFiles, [], 'no stubbed files at ok');
}

{
  // 7. Trimming reference fits.
  // Critical 'A' is small. Reference 'B' has full=very long, trimmed=tiny.
  const longB = 'x'.repeat(2000);
  const items = [
    makeItem('a', 'critical', 'a-content'),
    makeItem('b', 'reference', longB, 'tiny-b'),
  ];
  // Budget big enough for trimmed but not full.
  const { resolvedItems, selection } = selectCanonicalContent(items, 200, measureBody);
  assertEq(selection.status, 'trimmed', 'status trimmed when stage 2 fits');
  assertEq(resolvedItems[0].content, 'a-content', 'critical kept as full');
  assertEq(resolvedItems[1].content, 'tiny-b', 'reference resolved to trimmed');
  assertEq(selection.trimmedFiles, ['b'], 'b listed as trimmed');
}

{
  // 8. Trimmed still over → stubbed.
  // Critical small, reference both full and trimmed are too long, but stub fits.
  const items = [
    makeItem('a', 'critical', 'a-content'),
    makeItem('b', 'reference', 'x'.repeat(5000), 'y'.repeat(3000), '> stub-b'),
  ];
  const { resolvedItems, selection } = selectCanonicalContent(items, 100, measureBody);
  assertEq(selection.status, 'stubbed', 'status stubbed when only stub fits');
  assertEq(resolvedItems[1].content, '> stub-b', 'reference resolved to stub');
  assertEq(selection.stubbedFiles, ['b'], 'b listed as stubbed');
}

{
  // 9. Stubbed still over → over-budget.
  // Critical itself is over budget; nothing helps.
  const items = [
    makeItem('a', 'critical', 'x'.repeat(1000)),
    makeItem('b', 'reference', 'short', 'short', '> stub-b'),
  ];
  const { selection } = selectCanonicalContent(items, 50, measureBody);
  assertEq(selection.status, 'over-budget', 'status over-budget when stage 3 still over');
  assert(selection.overBy > 0, 'overBy populated');
  assert(typeof selection.overBy === 'number', 'overBy is a number');
}

{
  // 10. budgetBytes <= 0 → stage 1 wins, budget = null.
  const items = [
    makeItem('a', 'critical', 'x'.repeat(10000)),
    makeItem('b', 'reference', 'y'.repeat(10000), 'tiny'),
  ];
  const { resolvedItems, selection } = selectCanonicalContent(items, 0, measureBody);
  assertEq(selection.status, 'ok', 'status ok when budget disabled');
  assertEq(selection.budgetBytes, null, 'budgetBytes null when disabled');
  assertEq(resolvedItems[1].content, 'y'.repeat(10000), 'reference resolved to full when disabled');
}

{
  // 11. All critical, total > budget: status over-budget, no items modified.
  const items = [
    makeItem('a', 'critical', 'x'.repeat(1000)),
    makeItem('c', 'critical', 'z'.repeat(1000)),
  ];
  const { resolvedItems, selection } = selectCanonicalContent(items, 100, measureBody);
  assertEq(selection.status, 'over-budget', 'status over-budget when no reference files');
  assertEq(resolvedItems[0].content, 'x'.repeat(1000), 'critical a still full');
  assertEq(resolvedItems[1].content, 'z'.repeat(1000), 'critical c still full');
  assertEq(selection.trimmedFiles, [], 'no trimmed files');
  assertEq(selection.stubbedFiles, [], 'no stubbed files');
}

console.log('# buildCanonical priority');

{
  // 18. File with priority: reference → item.priority === 'reference'.
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'project-status.md'),
    `---
priority: reference
description: Status.
---

# Status

Some content.
`,
  );
  const items = buildCanonical(root);
  assertEq(items.length, 1, '1 item');
  assertEq(items[0].priority, 'reference', 'priority read as reference');
  assert(items[0].full.includes('Some content.'), 'full body present');
  cleanup(root);
}

{
  // 19. File without priority field → defaults to critical.
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'naming.md'),
    `---
description: Naming.
---

# Naming

Body.
`,
  );
  const items = buildCanonical(root);
  assertEq(items.length, 1, '1 item');
  assertEq(items[0].priority, 'critical', 'priority defaults to critical');
  cleanup(root);
}

console.log('# renderCanonical with budget');

{
  // 20. Budget set: header has budget/status frontmatter and budget blockquote.
  const resolved = [{ name: 'a', priority: 'critical', content: 'Hello.' }];
  const sel = {
    status: 'ok',
    budgetBytes: 40960,
    currentBytes: 12,
    trimmedFiles: [],
    stubbedFiles: [],
  };
  const out = renderCanonical(resolved, sel, '2026-04-28T00:00:00Z');
  assert(out.includes('budget: 40960'), 'frontmatter has budget');
  assert(out.includes('status: ok'), 'frontmatter has status');
  assert(out.includes('Budget: 40960 bytes (body); current: 12 bytes; status: ok (full).'), 'header blockquote present');
  assert(out.includes('## a'), 'item rendered');

  // Disabled budget: no budget frontmatter, no blockquote.
  const out2 = renderCanonical(resolved, NULL_SELECTION, '2026-04-28T00:00:00Z');
  assert(!out2.includes('budget:'), 'no budget frontmatter when disabled');
  assert(!out2.includes('Budget:'), 'no header blockquote when disabled');

  // Trimmed status summary.
  const sel3 = {
    status: 'trimmed',
    budgetBytes: 1000,
    currentBytes: 800,
    trimmedFiles: ['x', 'y'],
    stubbedFiles: [],
  };
  const out3 = renderCanonical(resolved, sel3, '2026-04-28T00:00:00Z');
  assert(out3.includes('2 reference files trimmed'), 'trimmed summary count');

  // Over-budget summary.
  const sel4 = {
    status: 'over-budget',
    budgetBytes: 100,
    currentBytes: 200,
    overBy: 100,
    trimmedFiles: [],
    stubbedFiles: ['z'],
  };
  const out4 = renderCanonical(resolved, sel4, '2026-04-28T00:00:00Z');
  assert(out4.includes('over budget by 100 bytes'), 'over-budget summary');
}

console.log('# regenerateAll end-to-end with trimming');

{
  // 21. Three locked files: critical, reference (with trim block), reference (no markers).
  // Budget tight enough that stage 2 (trimming) fits but stage 1 (full) does not.
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'a-critical.md'),
    `---
priority: critical
---

# Critical

` + 'C'.repeat(500) + '\n',
  );
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'b-reference-trimmable.md'),
    `---
priority: reference
---

# Reference Trimmable

Pre.

<!-- canonical:trim -->
` + 'X'.repeat(2000) + `
<!-- canonical:end-trim -->

Post.
`,
  );
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'c-reference-no-markers.md'),
    `---
priority: reference
---

# No Markers

Short body.
`,
  );
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({ workspace: { canonicalBudgetBytes: 1500 } }),
  );

  const artifacts = regenerateAll(root, '2026-04-28T00:00:00Z');
  const canonicalArt = artifacts.find((a) => a.label === 'canonical.md');
  assert(canonicalArt, 'canonical artifact present');
  const sel = canonicalArt.selection;
  assertEq(sel.status, 'trimmed', 'status trimmed at this budget');
  assertEq(sel.budgetBytes, 1500, 'budget echoed');
  assert(sel.currentBytes <= 1500, 'currentBytes within budget');
  assert(canonicalArt.content.includes('Critical'), 'critical content kept');
  assert(canonicalArt.content.includes('Trimmed for canonical budget'), 'breadcrumb present');
  assert(!canonicalArt.content.includes('X'.repeat(2000)), 'trimmed block dropped');
  assert(canonicalArt.content.includes('## c-reference-no-markers'), 'no-markers reference still present');
  assert(canonicalArt.content.includes('Short body.'), 'no-markers reference body kept (trimmed === full)');

  cleanup(root);
}

console.log('# CLI --check exit codes (canonical block)');

const scriptPath = new URL('./build-workspace-context.mjs', import.meta.url).pathname;

{
  // 22. --check on current/in-budget fixture: exit 0, status current, selectionStatus ok.
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'tiny.md'),
    `---
priority: critical
---

# Tiny

Body.
`,
  );
  // Write to make current.
  spawnSync('node', [scriptPath, '--write', '--root', root], { encoding: 'utf-8' });
  const r = spawnSync('node', [scriptPath, '--check', '--root', root], { encoding: 'utf-8' });
  assertEq(r.status, 0, 'exit 0 when current and in budget');
  const out = JSON.parse(r.stdout);
  assertEq(out.status, 'current', 'JSON status current');
  assert(out.canonical, 'canonical block present');
  assertEq(out.canonical.selectionStatus, 'ok', 'selectionStatus ok');
  cleanup(root);
}

{
  // 23. --check on stale fixture (artifact differs from source): exit 1, status stale.
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'one.md'),
    `---
priority: critical
---

Body.
`,
  );
  // No --write run, so canonical/index missing.
  const r = spawnSync('node', [scriptPath, '--check', '--root', root], { encoding: 'utf-8' });
  assertEq(r.status, 1, 'exit 1 when artifacts missing');
  const out = JSON.parse(r.stdout);
  assertEq(out.status, 'stale', 'JSON status stale');
  assert(out.missing.includes('canonical.md'), 'canonical.md flagged missing');
  cleanup(root);
}

{
  // 24. --check in-budget on disk but source content over budget → exit 2.
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'big-critical.md'),
    `---
priority: critical
---

` + 'A'.repeat(5000) + '\n',
  );
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({ workspace: { canonicalBudgetBytes: 100 } }),
  );
  // Write so disk matches what computation produces.
  spawnSync('node', [scriptPath, '--write', '--root', root], { encoding: 'utf-8' });
  const r = spawnSync('node', [scriptPath, '--check', '--root', root], { encoding: 'utf-8' });
  assertEq(r.status, 2, 'exit 2 when current but over budget');
  const out = JSON.parse(r.stdout);
  assertEq(out.status, 'current', 'JSON status current (artifacts in sync)');
  assertEq(out.canonical.selectionStatus, 'over-budget', 'selectionStatus over-budget');
  assert(typeof out.canonical.overBy === 'number' && out.canonical.overBy > 0, 'overBy populated');
  cleanup(root);
}

{
  // 25. --check both stale + over-budget: exit 1 (stale wins).
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'big.md'),
    `---
priority: critical
---

` + 'A'.repeat(5000) + '\n',
  );
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({ workspace: { canonicalBudgetBytes: 100 } }),
  );
  // Don't --write, so canonical.md is missing.
  const r = spawnSync('node', [scriptPath, '--check', '--root', root], { encoding: 'utf-8' });
  assertEq(r.status, 1, 'exit 1 (stale wins over over-budget)');
  const out = JSON.parse(r.stdout);
  assertEq(out.status, 'stale', 'JSON status stale');
  cleanup(root);
}

{
  // 26. --check disabled budget: exit 0 with huge canonical, canonical.budget = null.
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'huge.md'),
    `---
priority: critical
---

` + 'A'.repeat(50000) + '\n',
  );
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({ workspace: { canonicalBudgetBytes: 0 } }),
  );
  spawnSync('node', [scriptPath, '--write', '--root', root], { encoding: 'utf-8' });
  const r = spawnSync('node', [scriptPath, '--check', '--root', root], { encoding: 'utf-8' });
  assertEq(r.status, 0, 'exit 0 when budget disabled even with huge canonical');
  const out = JSON.parse(r.stdout);
  assertEq(out.canonical.budget, null, 'canonical.budget null when disabled');
  assertEq(out.canonical.selectionStatus, 'ok', 'selectionStatus ok when disabled');
  cleanup(root);
}

{
  // 27. Stderr warning fires for reference file with no markers.
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'ref-no-markers.md'),
    `---
priority: reference
---

# Reference

Body without markers.
`,
  );
  const r = spawnSync('node', [scriptPath, '--check', '--root', root], { encoding: 'utf-8' });
  assert(/no canonical:trim markers/.test(r.stderr), 'warning about missing markers in stderr');
  assert(/ref-no-markers/.test(r.stderr), 'warning names the file');
  cleanup(root);
}

{
  // 28. Stderr warning fires when over-budget with no reference files.
  const root = setupFixture();
  writeFileSync(
    join(root, 'workspace-context', 'shared', 'locked', 'all-critical.md'),
    `---
priority: critical
---

` + 'A'.repeat(5000) + '\n',
  );
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({ workspace: { canonicalBudgetBytes: 100 } }),
  );
  spawnSync('node', [scriptPath, '--write', '--root', root], { encoding: 'utf-8' });
  const r = spawnSync('node', [scriptPath, '--check', '--root', root], { encoding: 'utf-8' });
  assert(/no priority:reference files exist/.test(r.stderr), 'warning when over-budget with all-critical');
  cleanup(root);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
