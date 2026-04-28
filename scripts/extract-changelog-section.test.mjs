#!/usr/bin/env node
// Unit tests for extract-changelog-section.mjs
// Run: node scripts/extract-changelog-section.test.mjs

import { extractChangelogSection } from './extract-changelog-section.mjs';

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

console.log('# extractChangelogSection');

{
  const content = `# Changelog

## v0.15.0

- first bullet
- second bullet
`;
  assertEq(
    extractChangelogSection(content, '0.15.0'),
    '- first bullet\n- second bullet',
    'extracts single version section',
  );
}

{
  const content = `# Changelog

## v0.15.0

- new bullet

## v0.14.0

- old bullet
`;
  const result = extractChangelogSection(content, '0.15.0');
  assertEq(result, '- new bullet', 'returns only requested version when multiple present');
  assert(!result.includes('old bullet'), 'must not leak next version body');
  assert(!result.includes('## v0.14.0'), 'must not include next heading');
}

{
  const content = `# Changelog

## v0.15.0

- bullet
`;
  assertEq(
    extractChangelogSection(content, '99.99.99'),
    '',
    'returns empty string when version not found',
  );
}

{
  const content = `# Changelog

Intro paragraph that should not appear in any extracted body.

## v0.15.0
- bullet
`;
  const result = extractChangelogSection(content, '0.15.0');
  assertEq(result, '- bullet', 'excludes header content before first version heading');
  assert(!result.includes('Intro paragraph'), 'header must not leak');
  assert(!result.includes('# Changelog'), 'top-level title must not leak');
}

{
  const content = `# Changelog

## v0.15.0

- only bullet
- second bullet to EOF`;
  assertEq(
    extractChangelogSection(content, '0.15.0'),
    '- only bullet\n- second bullet to EOF',
    'extracts last-version-in-file body to EOF',
  );
}

{
  const content = `## v0.15.0

- main bullet

### Known issues

- known issue one

## v0.14.0

- old
`;
  const result = extractChangelogSection(content, '0.15.0');
  assert(result.includes('### Known issues'), 'subsection heading present');
  assert(result.includes('- known issue one'), 'subsection body present');
  assert(result.includes('- main bullet'), 'main bullets present');
  assert(!result.includes('## v0.14.0'), 'next version not included');
  assert(!result.includes('- old'), 'next version body not included');
}

{
  const content = `## v0.14.0-beta.2 — 2026-04-26 *(unpublished — superseded by beta.3)*

- annotated bullet
`;
  assertEq(
    extractChangelogSection(content, '0.14.0-beta.2'),
    '- annotated bullet',
    'matches heading despite trailing date / unpublished suffix',
  );
}

{
  const content = `## v0.15.0

- shared bullet
`;
  const withV = extractChangelogSection(content, 'v0.15.0');
  const withoutV = extractChangelogSection(content, '0.15.0');
  assertEq(withV, '- shared bullet', 'accepts version arg with leading v');
  assertEq(withoutV, '- shared bullet', 'accepts version arg without leading v');
  assertEq(withV, withoutV, 'leading v is normalized');
}

{
  const content =
    '# Changelog\r\n' +
    '\r\n' +
    '## v0.15.0\r\n' +
    '\r\n' +
    '- crlf bullet one\r\n' +
    '- crlf bullet two\r\n';
  const result = extractChangelogSection(content, '0.15.0');
  assert(!result.includes('\r'), 'output must not contain CR characters');
  assertEq(result, '- crlf bullet one\n- crlf bullet two', 'normalizes CRLF input to LF output');
}

{
  const content =
    '﻿' +
    `## v0.15.0

- bom bullet
`;
  assertEq(
    extractChangelogSection(content, '0.15.0'),
    '- bom bullet',
    'strips UTF-8 BOM from file start',
  );
}

{
  const content = `## v0.15.0

### Known issues
- thing
`;
  const result = extractChangelogSection(content, '0.15.0');
  assert(result.length > 0, 'body must not be empty');
  assert(result.includes('### Known issues'), 'subsection heading present');
  assert(result.includes('- thing'), 'subsection body present');
}

{
  const content = [
    '## v0.15.0',
    '',
    '   ',
    '',
    '## v0.14.0',
    '',
    '- old',
    '',
  ].join('\n');
  assertEq(
    extractChangelogSection(content, '0.15.0'),
    '',
    'returns empty string when body is whitespace-only',
  );
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
