#!/usr/bin/env node
// Pre-publish safety net. Runs via `npm run audit:tarball`, wired into
// package.json `prepublishOnly` so `npm publish` cannot ship a tarball that
// leaks personal references, omits required structural files, includes
// forbidden ones, exceeds a sane size, drifts from the README's claimed
// counts, or carries a non-minimal permissions allowlist.
//
// On any violation: prints `Audit failed:` to stderr followed by one line per
// violation, then exits 1. On success: one line `Audit OK — N files, X.X kB.`
// and exits 0.

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// File extensions we treat as text and scan for content denylist matches.
// Anything not in this set is treated as binary/opaque and skipped.
const TEXT_EXTENSIONS = new Set([
  '.mjs',
  '.js',
  '.cjs',
  '.ts',
  '.json',
  '.md',
  '.skip',
  '.tmpl',
  '.txt',
  '.yml',
  '.yaml',
  '.sh',
  '.toml',
  '.gitignore',
]);

// Files without an extension that we still want to scan as text.
const TEXT_FILENAMES = new Set(['LICENSE', '_gitignore']);

const SAFE_PERMISSIONS = new Set(['Bash(git:*)', 'Bash(ls:*)']);

// Hard size ceiling. Current tarball is ~104 kB; 150 kB leaves headroom for
// legitimate growth but trips loudly if something like docs/ or node_modules/
// gets pulled in by accident.
const SIZE_LIMIT_BYTES = 150 * 1024;

function runDryRun() {
  const raw = execSync('npm pack --dry-run --json', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('npm pack --dry-run --json returned unexpected shape');
  }
  return parsed[0];
}

function isTextFile(path) {
  const base = path.split('/').pop();
  if (TEXT_FILENAMES.has(base)) return true;
  // Treat dotfiles by their full extension chain (e.g. .md.skip -> .skip).
  const ext = extname(path);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // Catch .md.skip explicitly — extname returns .skip which we already allow.
  return false;
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function snippetAround(content, index, matchLength) {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  let lineEnd = content.indexOf('\n', index + matchLength);
  if (lineEnd === -1) lineEnd = content.length;
  return content.slice(lineStart, lineEnd).trim().slice(0, 160);
}

function scanContentDenylist(files) {
  const violations = [];

  // Patterns that are unconditionally a leak.
  const absolutePathPatterns = [
    { name: 'macOS home path', re: /\/Users\/[A-Za-z0-9_.-]+/g },
    { name: 'linux home path', re: /\/home\/[a-z][a-z0-9_-]*\//g },
  ];

  // Context-bound user matches — only flag where "myron" appears in a way
  // that would actually identify the maintainer. Bare prose mentions like
  // "the convention is `shared-context/{username}/`" do not match.
  const contextBoundUserPatterns = [
    { name: 'frontmatter author', re: /^author:\s*myron/gim },
    { name: 'frontmatter user', re: /^user:\s*myron/gim },
    { name: 'shared-context user dir', re: /shared-context\/myron/g },
    { name: 'CLI --user value', re: /--user\s+["']?myron["']?/g },
  ];

  // Exact dogfood-slug matches that should never appear in a published
  // template. Bare "ukt-solutions" is allowed because it appears legitimately
  // in package.json `repository`/`homepage`/`bugs`.
  const dogfoodPatterns = [
    { name: 'dogfood workspace slug', re: /ukt-solutions\/ulysses-workspace/g },
    { name: 'maintainer username', re: /myrondavis/g },
    { name: 'maintainer org', re: /omnivativ/g },
  ];

  const allPatterns = [
    ...absolutePathPatterns,
    ...contextBoundUserPatterns,
    ...dogfoodPatterns,
  ];

  for (const file of files) {
    if (!isTextFile(file.path)) continue;
    const fullPath = join(REPO_ROOT, file.path);
    let content;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      continue; // Symlink, missing, or unreadable — skip rather than crash.
    }
    for (const { name, re } of allPatterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(content)) !== null) {
        violations.push({
          kind: 'content-leak',
          details: `${file.path}:${lineNumberAt(content, match.index)} [${name}] ${snippetAround(content, match.index, match[0].length)}`,
        });
      }
    }
  }

  return violations;
}

function checkForbiddenFiles(files) {
  const forbidden = [
    { name: '.env file', re: /\.env(\..+)?$/ },
    { name: '.DS_Store', re: /\.DS_Store$/ },
    { name: 'node_modules', re: /node_modules\// },
    { name: 'settings.local.json', re: /template\/\.claude\/settings\.local\.json$/ },
    { name: 'local-only path', re: /local-only-/ },
    { name: 'shared-context in template', re: /template\/shared-context\// },
    { name: 'work-sessions in template', re: /template\/work-sessions\// },
  ];
  const violations = [];
  for (const file of files) {
    for (const { name, re } of forbidden) {
      if (re.test(file.path)) {
        violations.push({
          kind: 'forbidden-file',
          details: `${file.path} [${name}]`,
        });
      }
    }
  }
  return violations;
}

function checkRequiredFiles(files) {
  const required = [
    'bin/create.mjs',
    'lib/init.mjs',
    'lib/upgrade.mjs',
    'template/CLAUDE.md.tmpl',
    'template/_gitignore',
    'template/.claude/settings.json',
    'LICENSE',
  ];
  const present = new Set(files.map((f) => f.path));
  return required
    .filter((path) => !present.has(path))
    .map((path) => ({ kind: 'missing-required', details: path }));
}

function checkSettingsSanity() {
  const settingsPath = join(REPO_ROOT, 'template/.claude/settings.json');
  const violations = [];
  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (err) {
    violations.push({
      kind: 'settings-unreadable',
      details: `${settingsPath}: ${err.message}`,
    });
    return violations;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    violations.push({
      kind: 'settings-invalid-json',
      details: `${settingsPath}: ${err.message}`,
    });
    return violations;
  }

  const allow = parsed?.permissions?.allow;
  if (!Array.isArray(allow)) {
    violations.push({
      kind: 'extra-permissions',
      details: `${settingsPath}: permissions.allow is missing or not an array`,
    });
  } else {
    const extras = allow.filter((entry) => !SAFE_PERMISSIONS.has(entry));
    if (extras.length > 0) {
      violations.push({
        kind: 'extra-permissions',
        details: `${settingsPath}: unexpected entries ${JSON.stringify(extras)}`,
      });
    }
  }

  const leakPatterns = [
    { name: 'macOS home path', re: /\/Users\// },
    { name: 'linux home path', re: /\/home\// },
    { name: 'sk- token', re: /sk-[a-zA-Z0-9]{20,}/ },
    { name: 'Bearer token', re: /Bearer\s+/i },
    { name: 'GitHub PAT', re: /ghp_/ },
  ];
  for (const { name, re } of leakPatterns) {
    if (re.test(raw)) {
      violations.push({
        kind: 'settings-leak',
        details: `${settingsPath}: matched ${name}`,
      });
    }
  }

  return violations;
}

function checkSizeBound(totalBytes) {
  if (totalBytes > SIZE_LIMIT_BYTES) {
    return [
      {
        kind: 'size-warning',
        details: `tarball is ${totalBytes} bytes, ceiling is ${SIZE_LIMIT_BYTES} (${(SIZE_LIMIT_BYTES / 1024).toFixed(0)} kB)`,
      },
    ];
  }
  return [];
}

function countDirEntries(dir, predicate) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => predicate(name, join(dir, name))).length;
}

function checkReadmeCounts() {
  const readmePath = join(REPO_ROOT, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');

  // Pull each claim out of the prose. Patterns target the README's "What you
  // get" bullet list — adjust here if that section is rephrased.
  const claims = {
    skills: readme.match(/(\d+)\s+skills/i),
    activeRules: readme.match(/(\d+)\s+active rules/i),
    optionalRules: readme.match(/(\d+)\s+optional\s+`?\.skip`?\s+rules/i),
    hooks: readme.match(/(\d+)\s+hooks/i),
  };

  const skillsDir = join(REPO_ROOT, 'template/.claude/skills');
  const rulesDir = join(REPO_ROOT, 'template/.claude/rules');
  const hooksDir = join(REPO_ROOT, 'template/.claude/hooks');

  const actual = {
    skills: countDirEntries(skillsDir, (_name, full) => {
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    }),
    activeRules: countDirEntries(
      rulesDir,
      (name) => name.endsWith('.md') && !name.endsWith('.md.skip'),
    ),
    optionalRules: countDirEntries(rulesDir, (name) => name.endsWith('.md.skip')),
    hooks: countDirEntries(
      hooksDir,
      (name) => name.endsWith('.mjs') && !name.startsWith('_'),
    ),
  };

  const labels = {
    skills: 'skills',
    activeRules: 'active rules',
    optionalRules: 'optional .skip rules',
    hooks: 'hooks',
  };

  const violations = [];
  for (const key of Object.keys(claims)) {
    const match = claims[key];
    if (!match) {
      violations.push({
        kind: 'count-drift',
        details: `${labels[key]}: README does not state a count (regex did not match)`,
      });
      continue;
    }
    const claimed = Number(match[1]);
    if (claimed !== actual[key]) {
      violations.push({
        kind: 'count-drift',
        details: `${labels[key]}: README claims ${claimed}, filesystem has ${actual[key]}`,
      });
    }
  }
  return violations;
}

function main() {
  const result = runDryRun();
  const files = result.files;

  const violations = [
    ...scanContentDenylist(files),
    ...checkForbiddenFiles(files),
    ...checkRequiredFiles(files),
    ...checkSettingsSanity(),
    ...checkSizeBound(result.size),
    ...checkReadmeCounts(),
  ];

  if (violations.length > 0) {
    process.stderr.write('Audit failed:\n');
    for (const v of violations) {
      process.stderr.write(` - ${v.kind}: ${v.details}\n`);
    }
    process.exit(1);
  }

  const kb = (result.size / 1024).toFixed(1);
  process.stdout.write(`Audit OK — ${files.length} files, ${kb} kB.\n`);
  process.exit(0);
}

main();
