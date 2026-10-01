#!/usr/bin/env node
/**
 * forbidden-word-grep.mjs — sweep documentation for user-supplied words
 * the documentation should avoid.
 *
 * The word list comes from the Phase 1 language-constraints answer in
 * the spec. Each project supplies its own list — there is no default.
 *
 * Usage:
 *   node forbidden-word-grep.mjs <docs-path> <wordlist.json> [--word-boundary] [--case-sensitive]
 *
 * Word list format (JSON):
 *   ["word1", "word2", "phrase three"]
 *
 *   Or with metadata per word:
 *   [
 *     {"word": "grounded", "reason": "implies the design was causally grounded in research"},
 *     {"word": "leverage", "reason": "corporate filler"}
 *   ]
 *
 * Output: JSON to stdout
 *   {
 *     wordsChecked: [...],
 *     hits: [{file, line, word, context, reason}],
 *     summary: {fileCount, hitCount}
 *   }
 *
 * Exit code: 0 if no hits, 1 if hits found.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------- CLI parsing ----------

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: forbidden-word-grep.mjs <docs-path> <wordlist.json> [--word-boundary] [--case-sensitive]');
  process.exit(1);
}

const docsPath = args[0];
const wordlistPath = args[1];
const wordBoundary = args.includes('--word-boundary');
const caseSensitive = args.includes('--case-sensitive');

// ---------- Word list parsing ----------

let wordlistRaw;
try {
  wordlistRaw = JSON.parse(readFileSync(wordlistPath, 'utf8'));
} catch (err) {
  console.error(`Failed to read word list: ${err.message}`);
  process.exit(2);
}

if (!Array.isArray(wordlistRaw)) {
  console.error('Word list must be a JSON array');
  process.exit(2);
}

// Normalize to {word, reason} entries
const wordEntries = wordlistRaw.map((entry) => {
  if (typeof entry === 'string') {
    return { word: entry, reason: null };
  }
  if (typeof entry === 'object' && entry !== null && typeof entry.word === 'string') {
    return { word: entry.word, reason: entry.reason ?? null };
  }
  console.error(`Invalid word list entry: ${JSON.stringify(entry)}`);
  process.exit(2);
});

if (wordEntries.length === 0) {
  console.log(JSON.stringify({ wordsChecked: [], hits: [], summary: { fileCount: 0, hitCount: 0 } }, null, 2));
  process.exit(0);
}

// ---------- Doc walking and grepping ----------

const hits = [];
let fileCount = 0;

function walkDocs(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkDocs(full);
    } else if (/\.(md|mdx)$/.test(entry)) {
      grepFile(full);
      fileCount++;
    }
  }
}

function grepFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  const lines = content.split('\n');
  const relPath = relative(process.cwd(), filePath);

  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue; // Don't flag inside code blocks

    for (const entry of wordEntries) {
      const escaped = entry.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = wordBoundary ? `\\b${escaped}\\b` : escaped;
      const flags = caseSensitive ? '' : 'i';
      const regex = new RegExp(pattern, flags);
      if (regex.test(line)) {
        hits.push({
          file: relPath,
          line: i + 1,
          word: entry.word,
          reason: entry.reason,
          context: line.trim().slice(0, 200),
        });
      }
    }
  }
}

// ---------- Run ----------

walkDocs(docsPath);

const result = {
  wordsChecked: wordEntries.map((e) => e.word),
  hits,
  summary: {
    fileCount,
    hitCount: hits.length,
  },
};

console.log(JSON.stringify(result, null, 2));
process.exit(hits.length > 0 ? 1 : 0);
