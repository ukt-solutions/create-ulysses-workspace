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

// Hard size ceiling. Current tarball is ~192 kB after the round-1
// task-model fixes (detect --chat, remote-branch resume, the
// repo-write-detection carve-out and its test); 195 kB leaves headroom for
// the next bit of growth. Trips loudly if something like docs/ or
// node_modules/ gets pulled in by accident.
//
// Bump history: 150 kB initial → 155 kB after BP-10's session-end reflection
// added ~750 bytes → 170 kB after the forges/ adapter family added ~13 kB of
// adapter code + ~15 kB of tests → 185 kB after context-footprint.mjs and
// workspace-diagnostics.mjs added ~59 kB, of which ~26 kB is test code →
// 190 kB after the task-model scripts (gh:132 stage 2) → 195 kB after the
// stage-2 review fixes grew task-worktree.mjs and its suite and added the
// repo-write-detection test → 200 kB after the workspace repo became a task
// target (gh:146 / Q6) grew task-worktree.mjs, its suite, and the
// repo-write-detection suite → 215 kB after the session→task migration
// added migrate-sessions.mjs + its suite + the /migrate-sessions skill
// (gh:147) → 225 kB after the gh:147 fix round: the teardown invariant,
// per-remote states, and the cleanup-work-session.mjs security rewrite
// grew migrate-sessions.mjs and both suites → still 225 kB after the
// gh:147 allowlist round (structure + tip allowlists, dry-run, submodule
// and regenerable-ignore handling): 227,168 bytes means 220 kB fails and
// 225 kB is the smallest passing multiple → 230 kB after the gh:155
// round grew the migration's switch step and its tests, bringing the
// tarball to 231,553 bytes — 225 kB fails and 230 kB is the smallest
// passing multiple → still 230 kB after the release-notes machinery was
// scrapped (gh:157): check-release-coverage.mjs and its test left, and
// migrate-sessions shed its gh:155 inventory — the tarball only shrank,
// so the ceiling holds → 245 kB once both landed: the upgrade-path fixes
// (gh:170 — classify-update.mjs + suite, --root migrator CLI tests,
// lib/upgrade.test.mjs) and the gh:172 review round (push-URL resolution,
// the divergent-push gate, verification at the push URL) together outgrow
// the 240 kB each needed alone (246,937 bytes combined); 245 kB is the
// smallest passing multiple → 250 kB after the /workspace-update dogfood
// round (gh:180) added maintenance-audit.mjs + its suite (~38 kB) and grew
// classify-update.mjs for the activated/removed lists: 255,435 bytes —
// 245 kB fails and 250 kB is the smallest passing multiple → 260 kB after
// the gh:180 fix round (signal-over-noise scoping, dedupe, report collapse
// + their tests): 256,922 bytes — 250 kB fails and 260 kB is the smallest
// passing multiple.
//
// Test files ship because template/ is included wholesale, matching the
// trackers/ and forges/ precedent. That is now ~15% of the tarball, which is
// worth revisiting as a whole rather than by carving out one directory.
const SIZE_LIMIT_BYTES = 260 * 1024;

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
    { name: 'settings.local.json', re: /template\/_claude\/settings\.local\.json$/ },
    // The template stores these under the inert names _claude/ and
    // _mcp.json; the protected live names must never creep back in, or
    // headless workers lose the ability to edit the template.
    { name: 'protected .claude/ in template', re: /^template\/\.claude\// },
    { name: 'protected .mcp.json in template', re: /^template\/\.mcp\.json$/ },
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
    'template/CODEBASE.md.tmpl',
    'template/repo-claude.md.tmpl',
    'template/_gitignore',
    'template/.claudeignore',
    'template/_claude/settings.json',
    'template/_claude/scripts/forges/interface.mjs',
    'template/_claude/scripts/forges/github.mjs',
    'template/_claude/scripts/forges/gitlab.mjs',
    // The context-placement skill and the memory-guidance rule both instruct
    // Claude to price a placement before writing it. If this script does not
    // ship, that instruction silently becomes advice nobody can follow.
    'template/_claude/scripts/context-footprint.mjs',
    // The chat record is the durable per-chat state in the post-inversion
    // session model (gh:132). Without it the new lifecycle has nowhere to
    // record scope, concerns, or open tasks.
    'template/_claude/scripts/chat-record.mjs',
    // Task worktrees are the task lifecycle's on-disk half (gh:132 stage 2).
    // Without this script /start-work cannot create them and /complete-work
    // cannot tell the two lifecycles apart.
    'template/_claude/scripts/task-worktree.mjs',
    // The task lifecycle's PR half (gh:163): push + one PR per repo, then
    // ordered merge, launcher pull, and issue close. Without it task
    // completion falls back to hand-written adapter blocks.
    'template/_claude/scripts/task-pr.mjs',
    'template/_claude/scripts/classify-update.mjs',
    // The scripted audit behind /maintenance audit and the post-update
    // verification in /workspace-update (gh:180). Without it both skills fall
    // back to hand-walking seven sections of prose checks per run.
    'template/_claude/scripts/maintenance-audit.mjs',
    // The per-workspace session→task migration (gh:147). Without it
    // /migrate-sessions cannot inventory, back up, or drain old sessions,
    // and existing workspaces have no path onto the task model.
    'template/_claude/scripts/migrate-sessions.mjs',
    'LICENSE',
  ];
  const present = new Set(files.map((f) => f.path));
  return required
    .filter((path) => !present.has(path))
    .map((path) => ({ kind: 'missing-required', details: path }));
}

function checkSettingsSanity() {
  const settingsPath = join(REPO_ROOT, 'template/_claude/settings.json');
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

  const deny = parsed?.permissions?.deny;
  if (!Array.isArray(deny)) {
    violations.push({ kind: 'missing-deny', details: `${settingsPath}: permissions.deny is missing or not an array` });
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

  const skillsDir = join(REPO_ROOT, 'template/_claude/skills');
  const rulesDir = join(REPO_ROOT, 'template/_claude/rules');
  const hooksDir = join(REPO_ROOT, 'template/_claude/hooks');

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
      // A hook is a non-test, non-underscore .mjs: *.test.mjs files share
      // the directory (the `_` prefix is the older convention for the same
      // thing) and must not inflate the shipped-hook count.
      (name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !name.startsWith('_'),
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

function checkCLAUDEMdTmpl() {
  const tmplPath = join(REPO_ROOT, 'template/CLAUDE.md.tmpl');
  const content = readFileSync(tmplPath, 'utf8');
  const violations = [];
  if (!content.includes('## Quick Reference'))
    violations.push({ kind: 'claude-md-tmpl', details: 'missing "## Quick Reference" heading' });
  if (!content.includes('@workspace-context/canonical.md'))
    violations.push({ kind: 'claude-md-tmpl', details: 'missing "@workspace-context/canonical.md" import' });
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes >= 3000)
    violations.push({ kind: 'claude-md-tmpl', details: `CLAUDE.md.tmpl is ${bytes} bytes (ceiling 3000)` });
  return violations;
}

// Every skill directory under template/_claude/skills/ must be listed in
// CLAUDE.md.tmpl as `/{name}` — the skill list is how sessions discover what
// exists, and an unlisted skill is invisible to every workspace. Workspaces
// may exclude skills locally; the template ships none excluded.
function checkSkillListings() {
  const tmpl = readFileSync(join(REPO_ROOT, 'template/CLAUDE.md.tmpl'), 'utf8');
  const skillsDir = join(REPO_ROOT, 'template/_claude/skills');
  const violations = [];
  let names = [];
  try {
    names = readdirSync(skillsDir).filter((name) => {
      try {
        return statSync(join(skillsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (err) {
    return [{ kind: 'skill-listing', details: `cannot read ${skillsDir}: ${err.message}` }];
  }
  for (const name of names) {
    if (!tmpl.includes(`/${name}`)) {
      violations.push({
        kind: 'skill-listing',
        details: `skill "${name}" is not listed as /${name} in template/CLAUDE.md.tmpl`,
      });
    }
  }
  return violations;
}

function checkMcpJson() {
  const mcpPath = join(REPO_ROOT, 'template/_mcp.json');
  try {
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
    if (typeof parsed?.mcpServers !== 'object' || parsed.mcpServers === null)
      return [{ kind: 'mcp-json', details: 'template/_mcp.json: missing or invalid mcpServers key' }];
  } catch (err) {
    return [{ kind: 'mcp-json', details: `template/_mcp.json: ${err.message}` }];
  }
  return [];
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
    ...checkCLAUDEMdTmpl(),
    ...checkSkillListings(),
    ...checkMcpJson(),
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
