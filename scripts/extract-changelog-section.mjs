#!/usr/bin/env node
/**
 * Extracts a single version section from CHANGELOG.md.
 *
 * Section delimiters:
 *   - Start: line matching ^## v{version}(?=\s|$)  (anchored, version may be followed by date or annotation)
 *   - End: next line matching ^## v (excluded), or EOF
 *
 * Quirks handled:
 *   - UTF-8 BOM stripped
 *   - CRLF normalized to LF
 *   - Version arg accepts `v0.15.0` or `0.15.0`
 *   - Whitespace-only body returns empty string (not-found)
 *
 * Used by .github/workflows/publish.yml to populate GitHub Release body
 * from the curated CHANGELOG entry rather than --generate-notes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractChangelogSection(content, version) {
  // Strip UTF-8 BOM if present.
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  // Normalize CRLF to LF.
  content = content.replace(/\r\n/g, '\n');

  // Strip leading `v` from version argument.
  const normalized = version.startsWith('v') ? version.slice(1) : version;

  const headingRe = new RegExp(`^## v${escapeRegex(normalized)}(?=\\s|$)`);
  const nextHeadingRe = /^## v/;

  const lines = content.split('\n');
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      headingIndex = i;
      break;
    }
  }

  if (headingIndex === -1) return '';

  const bodyLines = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (nextHeadingRe.test(lines[i])) break;
    bodyLines.push(lines[i]);
  }

  // Trim leading and trailing blank lines.
  while (bodyLines.length > 0 && bodyLines[0].trim() === '') {
    bodyLines.shift();
  }
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop();
  }

  const body = bodyLines.join('\n');
  if (body.trim() === '') return '';
  return body;
}

function parseArgs(argv) {
  const args = { version: null, changelog: 'CHANGELOG.md', out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--changelog') {
      args.changelog = argv[++i];
    } else if (a === '--out') {
      args.out = argv[++i];
    } else if (!args.version) {
      args.version = a;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    process.stderr.write('Usage: extract-changelog-section.mjs <version> [--changelog FILE] [--out FILE]\n');
    process.exit(1);
  }
  const changelogPath = resolve(process.cwd(), args.changelog);
  const content = readFileSync(changelogPath, 'utf8');
  const section = extractChangelogSection(content, args.version);

  if (args.out) {
    writeFileSync(resolve(process.cwd(), args.out), section);
  } else {
    process.stdout.write(section);
    if (section.length > 0 && !section.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
  process.exit(0);
}

// Run only when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
