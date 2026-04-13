#!/usr/bin/env node
// Unit tests for session-frontmatter.mjs
// Run: node template/.claude/lib/session-frontmatter.test.mjs
import {
  parseSessionContent,
  updateSessionContent,
} from './session-frontmatter.mjs';

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

const SAMPLE = `---
type: session-tracker
name: fix-auth
description: Fix the auth timeout on mobile
status: active
branch: bugfix/fix-auth
created: 2026-04-13T05:33:50.000Z
user: myron
repos:
  - my-app
  - my-api
workItem: 3
chatSessions:
  - id: aa3c952e-dbff-4055-8bcc-e5f217618d57
    names: [pickup-from-braindump]
    started: 2026-04-13T05:33:50.000Z
    ended: 2026-04-13T07:12:00.000Z
  - id: bb4d063e-ec00-4166-cc71-cd3d3d4628a1
    names: []
    started: 2026-04-13T08:00:00.000Z
    ended: null
author: myron
updated: 2026-04-13
---

# Work Session: fix-auth

Brief one-liner.

## Progress

Some prose.
`;

// === Test 1: parse all field types ===
console.log('Test 1: parse all field types');
{
  const parsed = parseSessionContent(SAMPLE);
  assertEq(parsed.fields.type, 'session-tracker', 'type');
  assertEq(parsed.fields.name, 'fix-auth', 'name');
  assertEq(parsed.fields.description, 'Fix the auth timeout on mobile', 'description');
  assertEq(parsed.fields.status, 'active', 'status');
  assertEq(parsed.fields.branch, 'bugfix/fix-auth', 'branch');
  assertEq(parsed.fields.created, '2026-04-13T05:33:50.000Z', 'created (ISO timestamp unquoted)');
  assertEq(parsed.fields.workItem, 3, 'workItem (integer)');
  assertEq(parsed.fields.repos, ['my-app', 'my-api'], 'repos (flat list)');
  assertEq(parsed.fields.chatSessions.length, 2, 'chatSessions length');
  assertEq(parsed.fields.chatSessions[0].id, 'aa3c952e-dbff-4055-8bcc-e5f217618d57', 'chat 0 id');
  assertEq(parsed.fields.chatSessions[0].names, ['pickup-from-braindump'], 'chat 0 names');
  assertEq(parsed.fields.chatSessions[0].started, '2026-04-13T05:33:50.000Z', 'chat 0 started');
  assertEq(parsed.fields.chatSessions[0].ended, '2026-04-13T07:12:00.000Z', 'chat 0 ended');
  assertEq(parsed.fields.chatSessions[1].id, 'bb4d063e-ec00-4166-cc71-cd3d3d4628a1', 'chat 1 id');
  assertEq(parsed.fields.chatSessions[1].names, [], 'chat 1 names (empty inline list)');
  assertEq(parsed.fields.chatSessions[1].ended, null, 'chat 1 ended (null)');
  assert(parsed.body.startsWith('\n# Work Session'), 'body starts with blank line + H1');
  assert(parsed.body.endsWith('Some prose.\n'), 'body ends with trailing newline');
}

// === Test 2: lossless byte-identity on no-op update ===
console.log('Test 2: lossless byte-identity on no-op update');
{
  const unchanged = updateSessionContent(SAMPLE, {});
  assertEq(unchanged, SAMPLE, 'no-op update preserves content byte-identical');
}

// === Test 3: update single scalar field ===
console.log('Test 3: update single scalar field');
{
  const updated = updateSessionContent(SAMPLE, { status: 'paused' });
  const parsed = parseSessionContent(updated);
  assertEq(parsed.fields.status, 'paused', 'status changed');
  assertEq(parsed.fields.name, 'fix-auth', 'name preserved');
  assertEq(parsed.fields.repos, ['my-app', 'my-api'], 'repos preserved');
  assertEq(parsed.fields.chatSessions.length, 2, 'chatSessions preserved');
  // Verify every other line is byte-identical
  const origLines = SAMPLE.split('\n');
  const newLines = updated.split('\n');
  assertEq(newLines.length, origLines.length, 'same number of lines');
  for (let i = 0; i < origLines.length; i++) {
    if (origLines[i].startsWith('status:')) {
      assertEq(newLines[i], 'status: paused', `line ${i} is new status`);
    } else {
      assertEq(newLines[i], origLines[i], `line ${i} preserved`);
    }
  }
}

// === Test 4: update chatSessions array (append a chat) ===
console.log('Test 4: update chatSessions array');
{
  const parsed = parseSessionContent(SAMPLE);
  const newChats = [...parsed.fields.chatSessions, {
    id: 'cc5e174f-fd11-5277-dd82-de4e4e5739b2',
    names: [],
    started: '2026-04-13T09:00:00.000Z',
    ended: null,
  }];
  const updated = updateSessionContent(SAMPLE, { chatSessions: newChats });
  const reparsed = parseSessionContent(updated);
  assertEq(reparsed.fields.chatSessions.length, 3, 'chatSessions now has 3 entries');
  assertEq(reparsed.fields.chatSessions[2].id, 'cc5e174f-fd11-5277-dd82-de4e4e5739b2', 'new chat id');
  assertEq(reparsed.fields.name, 'fix-auth', 'other fields preserved');
  assertEq(reparsed.body, parsed.body, 'body preserved byte-identical');
}

// === Test 5: append a new field ===
console.log('Test 5: append a new field');
{
  const updated = updateSessionContent(SAMPLE, { newField: 'hello' });
  const parsed = parseSessionContent(updated);
  assertEq(parsed.fields.newField, 'hello', 'newField present');
  assertEq(parsed.fields.name, 'fix-auth', 'existing field preserved');
}

// === Test 6: remove a field ===
console.log('Test 6: remove a field');
{
  const updated = updateSessionContent(SAMPLE, { workItem: undefined });
  const parsed = parseSessionContent(updated);
  assertEq(parsed.fields.workItem, undefined, 'workItem removed');
  assertEq(parsed.fields.user, 'myron', 'user preserved');
}

// === Test 7: update repos (flat list) ===
console.log('Test 7: update repos flat list');
{
  const updated = updateSessionContent(SAMPLE, { repos: ['my-app', 'my-api', 'my-web'] });
  const parsed = parseSessionContent(updated);
  assertEq(parsed.fields.repos, ['my-app', 'my-api', 'my-web'], 'repos has 3 items');
  assertEq(parsed.fields.chatSessions.length, 2, 'chatSessions preserved after repos update');
}

// === Test 8: empty repos ===
console.log('Test 8: empty repos');
{
  const updated = updateSessionContent(SAMPLE, { repos: [] });
  const parsed = parseSessionContent(updated);
  assertEq(parsed.fields.repos, [], 'repos is empty');
}

// === Test 9: scalar with special chars (colon in branch name) ===
console.log('Test 9: scalar with special chars');
{
  // Branch names with slashes should NOT be quoted
  const sample = `---
branch: feature/worksessions-refactor
---
body
`;
  const parsed = parseSessionContent(sample);
  assertEq(parsed.fields.branch, 'feature/worksessions-refactor', 'branch unquoted');
  const noop = updateSessionContent(sample, {});
  assertEq(noop, sample, 'no-op preserves unquoted slash');
}

// === Test 10: ISO timestamp round-trip ===
console.log('Test 10: ISO timestamp round-trip');
{
  const sample = `---
created: 2026-04-13T05:33:50.000Z
---
body
`;
  const parsed = parseSessionContent(sample);
  assertEq(parsed.fields.created, '2026-04-13T05:33:50.000Z', 'ISO timestamp parsed');
  const updated = updateSessionContent(sample, { created: '2026-05-01T12:00:00.000Z' });
  const reparsed = parseSessionContent(updated);
  assertEq(reparsed.fields.created, '2026-05-01T12:00:00.000Z', 'ISO timestamp round-trip');
  // Must not be quoted
  assert(!updated.includes('"2026-05-01'), 'ISO timestamp not quoted on write');
}

// === Test 11: string that truly needs quoting ===
console.log('Test 11: string that truly needs quoting');
{
  const sample = `---
title: hello
---
body
`;
  const updated = updateSessionContent(sample, { title: 'hello: world' });
  assert(updated.includes('title: "hello: world"'), 'colon-space triggers quoting');
  const reparsed = parseSessionContent(updated);
  assertEq(reparsed.fields.title, 'hello: world', 'quoted value round-trips');
}

// === Test 12: body preservation with multiline content ===
console.log('Test 12: body preservation with multiline content');
{
  const sample = `---
name: test
---

# Heading

Paragraph with multiple lines.
And more lines.

- bullet 1
- bullet 2
`;
  const noop = updateSessionContent(sample, {});
  assertEq(noop, sample, 'multiline body preserved byte-identical');
  const updated = updateSessionContent(sample, { name: 'changed' });
  const parsed = parseSessionContent(updated);
  assertEq(parsed.body.trim(), '# Heading\n\nParagraph with multiple lines.\nAnd more lines.\n\n- bullet 1\n- bullet 2', 'body intact after update');
}

// === Summary ===
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
