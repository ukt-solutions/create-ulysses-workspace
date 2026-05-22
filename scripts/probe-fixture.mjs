#!/usr/bin/env node
// probe-fixture.mjs — Generate a minimal sample repo fixture for A/B behavioral probes.
//
// The fixture provides a concrete symbol-lookup scenario: three exported functions
// (parseDate, formatDate, computeDelta) backed by a private helper _toMs. Probes use
// "find all callers of _toMs" as the standard task, where LSP outperforms grep on
// accuracy and a CODEBASE.md reduces blind filesystem exploration.
//
// Usage:
//   node scripts/probe-fixture.mjs [--output <dir>]
//
// Exits 0 on success and prints the output path to stdout.
// Does not require npm install — the fixture is self-contained JS.

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseArgs } from 'util';

const { values } = parseArgs({
  options: {
    output: { type: 'string', short: 'o' },
  },
  strict: false,
});

const outDir = values.output || join(tmpdir(), `ulysses-probe-${Date.now()}`);

// Create directory structure
mkdirSync(join(outDir, 'src'), { recursive: true });
mkdirSync(join(outDir, 'test'), { recursive: true });

// root index.js — exports the three public functions
writeFileSync(
  join(outDir, 'index.js'),
  `'use strict';
const { parseDate, formatDate, computeDelta } = require('./src/date-utils');

module.exports = { parseDate, formatDate, computeDelta };
`
);

// src/date-utils.js — implements the public API plus a private helper _toMs
writeFileSync(
  join(outDir, 'src', 'date-utils.js'),
  `'use strict';

/**
 * Convert a Date or date-string to milliseconds since epoch.
 * Private helper used by parseDate, formatDate, and computeDelta.
 * @param {Date|string|number} value
 * @returns {number}
 */
function _toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/**
 * Parse a date string or value and return a Date object.
 * @param {string|number|Date} value
 * @returns {Date}
 */
function parseDate(value) {
  return new Date(_toMs(value));
}

/**
 * Format a date as an ISO date string (YYYY-MM-DD).
 * @param {string|number|Date} value
 * @returns {string}
 */
function formatDate(value) {
  return new Date(_toMs(value)).toISOString().slice(0, 10);
}

/**
 * Compute the difference in milliseconds between two dates.
 * @param {string|number|Date} start
 * @param {string|number|Date} end
 * @returns {number}
 */
function computeDelta(start, end) {
  return _toMs(end) - _toMs(start);
}

module.exports = { parseDate, formatDate, computeDelta, _toMs };
`
);

// test/date-utils.test.js — calls all three exported functions
writeFileSync(
  join(outDir, 'test', 'date-utils.test.js'),
  `'use strict';
const assert = require('assert');
const { parseDate, formatDate, computeDelta } = require('../index');

// parseDate: should return a Date from a string
const parsed = parseDate('2024-03-15');
assert(parsed instanceof Date, 'parseDate should return a Date');
assert.strictEqual(parsed.getFullYear(), 2024, 'year should be 2024');

// formatDate: should return YYYY-MM-DD string
const formatted = formatDate(new Date('2024-03-15'));
assert.strictEqual(formatted, '2024-03-15', 'formatDate should return ISO date string');

// computeDelta: should return difference in ms
const delta = computeDelta('2024-01-01', '2024-01-02');
assert.strictEqual(delta, 86400000, 'one day should be 86400000 ms');

console.log('All assertions passed.');
`
);

// package.json — minimal, no dependencies
writeFileSync(
  join(outDir, 'package.json'),
  JSON.stringify(
    {
      name: 'ulysses-probe-fixture',
      version: '0.0.1',
      description: 'Minimal fixture repo for Ulysses A/B behavioral probes.',
      main: 'index.js',
      scripts: {
        test: 'node test/date-utils.test.js',
      },
      license: 'MIT',
    },
    null,
    2
  ) + '\n'
);

// .gitignore — standard Node ignores
writeFileSync(
  join(outDir, '.gitignore'),
  'node_modules/\ndist/\n.build/\n'
);

// Print the output path and exit 0
process.stdout.write(outDir + '\n');
