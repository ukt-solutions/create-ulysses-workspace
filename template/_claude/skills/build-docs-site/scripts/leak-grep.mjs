#!/usr/bin/env node
/**
 * leak-grep.mjs — implementation-detail leak detector for the build-docs-site skill.
 *
 * Scans a project's dependency manifests to derive a list of installed
 * package names, then greps documentation content for any mention of
 * those names. The list is project-accurate — no hardcoded master list.
 *
 * Manifests scanned:
 *   - package.json (Node)
 *   - pyproject.toml (Python)
 *   - requirements.txt (Python)
 *   - Cargo.toml (Rust)
 *   - Gemfile (Ruby)
 *   - go.mod (Go)
 *
 * Excludes Tech Stack appendix files (where implementation choices are
 * the subject) by file path filter.
 *
 * Usage:
 *   node leak-grep.mjs <project-root> <docs-path> [--exclude path1,path2]
 *
 * Output: JSON to stdout
 *   {
 *     manifestsScanned: [...],
 *     packagesFound: [...],
 *     hits: [{file, line, term, context}],
 *     excluded: [...]
 *   }
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

// ---------- CLI parsing ----------

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: leak-grep.mjs <project-root> <docs-path> [--exclude path1,path2]');
  process.exit(1);
}

const projectRoot = args[0];
const docsPath = args[1];
const excludeFlag = args.indexOf('--exclude');
const userExcludes = excludeFlag >= 0 && args[excludeFlag + 1]
  ? args[excludeFlag + 1].split(',')
  : [];

// Default excludes — the Tech Stack appendix is where implementation
// details are the subject. Match common naming conventions.
const defaultExcludes = [
  'tech-stack',
  'appendix-tech-stack',
  'appendix/tech-stack',
  'technology',
  'stack',
];
const excludes = [...defaultExcludes, ...userExcludes];

// ---------- Manifest scanning ----------

const packageNames = new Set();
const manifestsScanned = [];

function scanManifests(dir) {
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
      // Skip common ignored directories
      if (['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__'].includes(entry)) {
        continue;
      }
      scanManifests(full);
    } else {
      const name = basename(full);
      if (['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'Gemfile', 'go.mod'].includes(name)) {
        const extracted = extractPackages(name, full);
        if (extracted.length > 0) {
          manifestsScanned.push(relative(projectRoot, full));
          extracted.forEach((p) => packageNames.add(p));
        }
      }
    }
  }
}

function extractPackages(manifestName, fullPath) {
  let content;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    return [];
  }

  switch (manifestName) {
    case 'package.json':
      return extractFromPackageJson(content);
    case 'pyproject.toml':
      return extractFromPyprojectToml(content);
    case 'requirements.txt':
      return extractFromRequirementsTxt(content);
    case 'Cargo.toml':
      return extractFromCargoToml(content);
    case 'Gemfile':
      return extractFromGemfile(content);
    case 'go.mod':
      return extractFromGoMod(content);
    default:
      return [];
  }
}

function extractFromPackageJson(content) {
  try {
    const parsed = JSON.parse(content);
    const all = {
      ...parsed.dependencies,
      ...parsed.devDependencies,
      ...parsed.peerDependencies,
      ...parsed.optionalDependencies,
    };
    return Object.keys(all).map((name) => {
      // Strip scope: @scope/name → name (also keep both for matching)
      const stripped = name.startsWith('@') ? name.split('/')[1] || name : name;
      return stripped;
    });
  } catch {
    return [];
  }
}

function extractFromPyprojectToml(content) {
  // Naive TOML parsing — look for dependency lines like:
  //   name = "..."  or  "package-name>=1.0"  or  package-name = "1.0"
  const names = new Set();
  const lines = content.split('\n');
  let inDeps = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inDeps = /\[(tool\.poetry\.|project\.|tool\.pdm\.)?(dev-)?dependencies\]/.test(trimmed);
      continue;
    }
    if (inDeps) {
      // poetry style: name = "1.0" or {version = "..."}
      const poetryMatch = trimmed.match(/^([a-zA-Z0-9][a-zA-Z0-9_-]*)\s*=/);
      if (poetryMatch) names.add(poetryMatch[1]);
      // pep621 style in dependencies array: "name>=1.0",
      const pep621Match = trimmed.match(/^["']([a-zA-Z0-9][a-zA-Z0-9_-]*)/);
      if (pep621Match) names.add(pep621Match[1]);
    }
  }
  return [...names];
}

function extractFromRequirementsTxt(content) {
  const names = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([a-zA-Z0-9][a-zA-Z0-9_-]*)/);
    if (match) names.push(match[1]);
  }
  return names;
}

function extractFromCargoToml(content) {
  const names = new Set();
  const lines = content.split('\n');
  let inDeps = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inDeps = /\[(dev-|build-)?dependencies\]/.test(trimmed);
      continue;
    }
    if (inDeps) {
      const match = trimmed.match(/^([a-zA-Z0-9][a-zA-Z0-9_-]*)\s*=/);
      if (match) names.add(match[1]);
    }
  }
  return [...names];
}

function extractFromGemfile(content) {
  const names = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*gem\s+["']([a-zA-Z0-9][a-zA-Z0-9_-]*)["']/);
    if (match) names.push(match[1]);
  }
  return names;
}

function extractFromGoMod(content) {
  const names = new Set();
  const lines = content.split('\n');
  let inRequire = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('require (')) {
      inRequire = true;
      continue;
    }
    if (inRequire && trimmed === ')') {
      inRequire = false;
      continue;
    }
    const lineToCheck = trimmed.startsWith('require ') ? trimmed.replace(/^require\s+/, '') : (inRequire ? trimmed : null);
    if (lineToCheck) {
      // last path segment as the package "name"
      const match = lineToCheck.match(/^[a-zA-Z0-9./_-]+/);
      if (match) {
        const segments = match[0].split('/');
        const last = segments[segments.length - 1];
        if (last) names.add(last);
      }
    }
  }
  return [...names];
}

// ---------- Doc walking and grepping ----------

const hits = [];
const excludedFiles = [];

function isExcluded(filePath) {
  const rel = relative(docsPath, filePath).replace(/\\/g, '/');
  return excludes.some((e) => rel.includes(e));
}

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
      if (isExcluded(full)) {
        excludedFiles.push(relative(projectRoot, full));
        continue;
      }
      grepFile(full);
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
  const relPath = relative(projectRoot, filePath);

  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue; // Don't flag terms in code blocks

    for (const pkg of packageNames) {
      // Word boundary match, case-sensitive
      // Skip very short package names (< 3 chars) to reduce noise
      if (pkg.length < 3) continue;
      const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`);
      if (regex.test(line)) {
        hits.push({
          file: relPath,
          line: i + 1,
          term: pkg,
          context: line.trim().slice(0, 200),
        });
      }
    }
  }
}

// ---------- Run ----------

scanManifests(projectRoot);
walkDocs(docsPath);

const result = {
  manifestsScanned,
  packagesFound: [...packageNames].sort(),
  excluded: excludedFiles,
  hits,
  summary: {
    manifestCount: manifestsScanned.length,
    packageCount: packageNames.size,
    excludedFileCount: excludedFiles.length,
    hitCount: hits.length,
  },
};

console.log(JSON.stringify(result, null, 2));
process.exit(hits.length > 0 ? 1 : 0);
