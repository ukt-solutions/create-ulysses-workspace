#!/usr/bin/env node
// Idempotent migrator: shared-context/ → workspace-context/ + new structure.
//
// Each step is independently idempotent. Running this on a partially-migrated
// or fully-migrated workspace is a no-op for already-applied steps.
//
// Usage:
//   node migrate-to-workspace-context.mjs [--root <path>] [--dry-run]
//
// Steps (each reports applied / skipped / noop):
//   1.  Rename shared-context/ → workspace-context/.
//   2.  Move workspace-context/locked/* into workspace-context/shared/locked/.
//   3.  Move root .md files in workspace-context/ into workspace-context/shared/.
//   4.  Move per-user dirs into workspace-context/team-member/{user}/.
//       Heuristic: if any file in the dir has `author: {dirname}` in
//       frontmatter, it's a user dir. Otherwise it's a project/topic dir
//       and goes into shared/{dirname}/.
//   5.  Apply naming convention: rename files matching frontmatter
//       type braindump/handoff/research to {type}_{stem}.md.
//   6.  Move root-level release-notes/ → workspace-context/release-notes/.
//   7.  Update CLAUDE.md: replace @shared-context/locked/ with the
//       canonical.md + index.md imports.
//   8.  Update workspace.json: rename sharedContextDir → workspaceContextDir
//       and update releaseNotesDir.
//   9.  Update .indexignore: prefix-shift entries that referenced the old
//       layout, add release-notes/ exclusion.
//   10. Generate CLAUDE.local.md if absent.
//   11. Delete the old build-shared-context-index.mjs script.
//   12. Run build-workspace-context.mjs --write to produce auto-files.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  renameSync,
  rmSync,
  unlinkSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { join, basename, resolve, sep, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSessionContent } from '../lib/session-frontmatter.mjs';
import { generateClaudeLocal } from './generate-claude-local.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const OLD = 'shared-context';
const NEW = 'workspace-context';
const SHARED = 'shared';
const LOCKED = 'locked';
const TEAM_MEMBER = 'team-member';

const RESERVED_AT_WC_ROOT = new Set([
  SHARED,
  TEAM_MEMBER,
  'release-notes',
  'scaffolder-release-history',
  'index.md',
  'canonical.md',
  '.indexignore',
  '.gitignore',
]);

function parseArgs(argv) {
  const args = { root: process.cwd(), dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

function isGitRepo(root) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf-8',
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function gitMv(root, src, dst, dryRun) {
  if (dryRun) return { ok: true, dry: true };
  // git mv refuses if dst dir doesn't exist; ensure parent
  mkdirSync(dirname(dst), { recursive: true });
  if (isGitRepo(root)) {
    const r = spawnSync('git', ['mv', src, dst], { cwd: root, encoding: 'utf-8' });
    if (r.status === 0) return { ok: true };
    // fall through to plain rename — happens for untracked files
  }
  renameSync(src, dst);
  return { ok: true };
}

function step(name, fn) {
  return (root, options) => {
    try {
      const result = fn(root, options) ?? {};
      return { name, status: result.status || 'applied', notes: result.notes || [] };
    } catch (e) {
      return { name, status: 'error', error: e.message };
    }
  };
}

// ---------- step 1: rename shared-context → workspace-context ----------

const step1 = step('rename-shared-context', (root, { dryRun }) => {
  const oldDir = join(root, OLD);
  const newDir = join(root, NEW);
  if (!existsSync(oldDir) && existsSync(newDir)) {
    return { status: 'skipped', notes: ['already renamed'] };
  }
  if (!existsSync(oldDir) && !existsSync(newDir)) {
    return { status: 'noop', notes: ['no shared-context to migrate'] };
  }
  if (existsSync(oldDir) && existsSync(newDir)) {
    throw new Error(
      'Both shared-context/ and workspace-context/ exist — manual cleanup needed',
    );
  }
  gitMv(root, OLD, NEW, dryRun);
  return { status: 'applied', notes: [`${OLD}/ → ${NEW}/`] };
});

// ---------- step 2: consolidate locked/ under shared/locked/ ----------

const step2 = step('consolidate-locked', (root, { dryRun }) => {
  const wcRoot = join(root, NEW);
  if (!existsSync(wcRoot)) return { status: 'noop' };

  const oldLocked = join(wcRoot, LOCKED);
  const newLocked = join(wcRoot, SHARED, LOCKED);
  if (!existsSync(oldLocked)) {
    return existsSync(newLocked)
      ? { status: 'skipped', notes: ['locked already under shared/'] }
      : { status: 'noop' };
  }

  // Both exist: move file-by-file, then drop the empty source dir.
  if (existsSync(newLocked)) {
    const notes = [];
    for (const name of readdirSync(oldLocked)) {
      const srcRel = `${NEW}/${LOCKED}/${name}`;
      const dstRel = `${NEW}/${SHARED}/${LOCKED}/${name}`;
      if (existsSync(join(root, dstRel))) {
        notes.push(`SKIP ${srcRel} (target exists)`);
        continue;
      }
      gitMv(root, srcRel, dstRel, dryRun);
      notes.push(`${srcRel} → ${dstRel}`);
    }
    if (!dryRun) {
      try { rmSync(oldLocked, { recursive: true, force: true }); } catch { /* keep */ }
    }
    return { status: notes.length > 0 ? 'applied' : 'skipped', notes };
  }

  // Common case: rename the whole locked/ dir into shared/locked/.
  if (!dryRun) mkdirSync(join(wcRoot, SHARED), { recursive: true });
  gitMv(root, `${NEW}/${LOCKED}`, `${NEW}/${SHARED}/${LOCKED}`, dryRun);
  return { status: 'applied', notes: [`${NEW}/${LOCKED}/ → ${NEW}/${SHARED}/${LOCKED}/`] };
});

// ---------- step 3: move root .md files into shared/ ----------

const step3 = step('move-root-md-into-shared', (root, { dryRun }) => {
  const wcRoot = join(root, NEW);
  if (!existsSync(wcRoot)) return { status: 'noop' };
  const sharedDir = join(wcRoot, SHARED);
  if (!dryRun) mkdirSync(sharedDir, { recursive: true });

  const notes = [];
  for (const name of readdirSync(wcRoot)) {
    if (!name.endsWith('.md')) continue;
    if (RESERVED_AT_WC_ROOT.has(name)) continue;
    const srcRel = `${NEW}/${name}`;
    const dstRel = `${NEW}/${SHARED}/${name}`;
    const dstAbs = join(root, dstRel);
    if (existsSync(dstAbs)) {
      notes.push(`SKIP ${srcRel} (destination exists)`);
      continue;
    }
    gitMv(root, srcRel, dstRel, dryRun);
    notes.push(`${srcRel} → ${dstRel}`);
  }
  return { status: notes.length > 0 ? 'applied' : 'skipped', notes };
});

// ---------- step 4: classify and move per-user / project dirs ----------

function dirLooksLikeUserScope(dirAbs, dirname) {
  if (!existsSync(dirAbs)) return false;
  const entries = readdirSync(dirAbs);
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const filePath = join(dirAbs, name);
    try {
      const parsed = parseSessionContent(readFileSync(filePath, 'utf-8'));
      if (parsed?.fields?.author === dirname) return true;
    } catch { /* keep scanning */ }
  }
  return false;
}

const step4 = step('move-user-and-project-dirs', (root, { dryRun }) => {
  const wcRoot = join(root, NEW);
  if (!existsSync(wcRoot)) return { status: 'noop' };

  const tmDir = join(wcRoot, TEAM_MEMBER);
  if (!dryRun) mkdirSync(tmDir, { recursive: true });
  const sharedDir = join(wcRoot, SHARED);
  if (!dryRun) mkdirSync(sharedDir, { recursive: true });

  const notes = [];
  for (const name of readdirSync(wcRoot)) {
    if (RESERVED_AT_WC_ROOT.has(name)) continue;
    if (name.endsWith('.md')) continue;  // handled in step 3

    const srcAbs = join(wcRoot, name);
    let st;
    try { st = statSync(srcAbs); } catch { continue; }
    if (!st.isDirectory()) continue;

    if (dirLooksLikeUserScope(srcAbs, name)) {
      const srcRel = `${NEW}/${name}`;
      const dstRel = `${NEW}/${TEAM_MEMBER}/${name}`;
      gitMv(root, srcRel, dstRel, dryRun);
      notes.push(`USER: ${srcRel} → ${dstRel}`);
    } else {
      const srcRel = `${NEW}/${name}`;
      const dstRel = `${NEW}/${SHARED}/${name}`;
      gitMv(root, srcRel, dstRel, dryRun);
      notes.push(`SHARED: ${srcRel} → ${dstRel}`);
    }
  }
  return { status: notes.length > 0 ? 'applied' : 'skipped', notes };
});

// ---------- step 5: apply naming convention ----------

function* walkMd(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walkMd(full);
    else if (st.isFile() && name.endsWith('.md')) yield full;
  }
}

const step5 = step('apply-naming-convention', (root, { dryRun }) => {
  const wcRoot = join(root, NEW);
  if (!existsSync(wcRoot)) return { status: 'noop' };

  const notes = [];
  for (const path of walkMd(wcRoot)) {
    const filename = basename(path);
    // Skip auto-gens and reserved names
    if (['index.md', 'canonical.md'].includes(filename)) continue;
    // Skip files already in locked/ (they use bare names by convention)
    if (path.includes(`${sep}${SHARED}${sep}${LOCKED}${sep}`)) continue;

    let parsed;
    try {
      parsed = parseSessionContent(readFileSync(path, 'utf-8'));
    } catch { continue; }

    const fmType = parsed?.fields?.type;
    if (!['braindump', 'handoff', 'research'].includes(fmType)) continue;

    const expectedPrefix = `${fmType}_`;
    if (filename.startsWith(expectedPrefix) || filename.startsWith(`local-only-${expectedPrefix}`)) {
      continue;
    }

    const stem = filename.replace(/^local-only-/, '').replace(/\.md$/, '');
    const localPrefix = filename.startsWith('local-only-') ? 'local-only-' : '';
    const newName = `${localPrefix}${expectedPrefix}${stem}.md`;
    const newPath = join(dirname(path), newName);
    if (existsSync(newPath)) {
      notes.push(`SKIP ${filename} (target ${newName} exists)`);
      continue;
    }
    const srcRel = path.replace(root + sep, '').split(sep).join('/');
    const dstRel = newPath.replace(root + sep, '').split(sep).join('/');
    gitMv(root, srcRel, dstRel, dryRun);
    notes.push(`${srcRel} → ${dstRel}`);
  }
  return { status: notes.length > 0 ? 'applied' : 'skipped', notes };
});

// ---------- step 6: move release-notes ----------

const step6 = step('move-release-notes', (root, { dryRun }) => {
  const oldRel = join(root, 'release-notes');
  const newRel = join(root, NEW, 'release-notes');
  if (!existsSync(oldRel) && existsSync(newRel)) {
    return { status: 'skipped', notes: ['already moved'] };
  }
  if (!existsSync(oldRel)) return { status: 'noop' };
  if (existsSync(newRel)) {
    return { status: 'skipped', notes: ['both old and new exist — manual merge needed'] };
  }
  // Ensure workspace-context exists
  if (!existsSync(join(root, NEW))) {
    return { status: 'skipped', notes: ['workspace-context/ missing — skipping'] };
  }
  gitMv(root, 'release-notes', `${NEW}/release-notes`, dryRun);
  return { status: 'applied', notes: [`release-notes/ → ${NEW}/release-notes/`] };
});

// ---------- step 7: patch CLAUDE.md ----------

const step7 = step('update-claude-md', (root, { dryRun }) => {
  const claudePath = join(root, 'CLAUDE.md');
  if (!existsSync(claudePath)) return { status: 'noop' };
  const before = readFileSync(claudePath, 'utf-8');

  const hasNewImports =
    before.includes(`@${NEW}/canonical.md`) && before.includes(`@${NEW}/index.md`);
  const hasOldImport = before.includes(`@${OLD}/locked/`) || before.includes(`@${NEW}/locked/`);

  if (hasNewImports && !hasOldImport) {
    return { status: 'skipped', notes: ['already migrated'] };
  }

  let after = before;

  // Replace the broken @shared-context/locked/ (or post-rename @workspace-context/locked/) line.
  // Match the heading + import line together so the heading text gets refreshed too.
  // Use [ \t]* (horizontal whitespace only) so we don't accidentally consume the
  // blank line that separates this block from the next heading.
  const oldImportBlockRe = new RegExp(
    `^## Team Knowledge[^\\n]*\\n@(?:${OLD}|${NEW})/locked/?[ \\t]*$`,
    'm',
  );
  const replacement = `## Team Knowledge\n@${NEW}/canonical.md\n@${NEW}/index.md`;
  if (oldImportBlockRe.test(after)) {
    after = after.replace(oldImportBlockRe, replacement);
  } else {
    // Fall back to single-line replacement if heading wasn't matched
    const oldImportRe = new RegExp(
      `^@(?:${OLD}|${NEW})/locked/?[ \\t]*$`,
      'm',
    );
    if (oldImportRe.test(after)) {
      after = after.replace(oldImportRe, `@${NEW}/canonical.md\n@${NEW}/index.md`);
    } else if (!hasNewImports) {
      // Append if no anchor existed
      after = after.trimEnd() + `\n\n${replacement}\n`;
    }
  }

  // Update copy in the Quick Reference area: "Shared memory lives in `shared-context/`"
  after = after.replace(/`shared-context\/`/g, '`workspace-context/`');
  after = after.replace(/Shared memory lives in/g, 'Team knowledge lives in');

  if (after === before) return { status: 'skipped' };
  if (!dryRun) writeFileSync(claudePath, after);
  return { status: 'applied', notes: ['CLAUDE.md imports updated'] };
});

// ---------- step 8: patch workspace.json ----------

const step8 = step('update-workspace-json', (root, { dryRun }) => {
  const wsPath = join(root, 'workspace.json');
  if (!existsSync(wsPath)) return { status: 'noop' };
  const raw = readFileSync(wsPath, 'utf-8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new Error(`workspace.json is not valid JSON: ${e.message}`);
  }
  const ws = parsed.workspace || {};
  const before = JSON.stringify(parsed);

  const hadOldKey = 'sharedContextDir' in ws;
  if (hadOldKey) {
    ws.workspaceContextDir = NEW;
    delete ws.sharedContextDir;
  } else if (!ws.workspaceContextDir) {
    ws.workspaceContextDir = NEW;
  }

  if (ws.releaseNotesDir === 'release-notes' || !ws.releaseNotesDir) {
    ws.releaseNotesDir = `${NEW}/release-notes`;
  }

  parsed.workspace = ws;
  const after = JSON.stringify(parsed, null, 2) + '\n';
  if (after === raw || JSON.stringify(parsed) === before) {
    return { status: 'skipped', notes: ['already up-to-date'] };
  }
  if (!dryRun) writeFileSync(wsPath, after);
  return { status: 'applied', notes: ['workspace.json updated'] };
});

// ---------- step 9: patch .indexignore ----------

const step9 = step('update-indexignore', (root, { dryRun }) => {
  const target = join(root, NEW, '.indexignore');
  if (!existsSync(target)) {
    if (!existsSync(join(root, NEW))) return { status: 'noop' };
    // create with sensible defaults
    const content =
      '# Workspace-context paths excluded from index.md.\n' +
      '# Lines are path prefixes relative to workspace-context/.\n' +
      '# A trailing slash matches a directory; bare paths match exactly.\n\n' +
      'release-notes/\n' +
      'shared/scaffolder-release-history/\n';
    if (!dryRun) writeFileSync(target, content);
    return { status: 'applied', notes: ['created .indexignore with defaults'] };
  }

  const before = readFileSync(target, 'utf-8');
  let after = before
    .replace(/Shared-context/g, 'Workspace-context')
    .replace(/shared-context/g, 'workspace-context');
  // Add release-notes/ if missing (release-notes/ now lives inside workspace-context/)
  const lines = after.split('\n');
  const hasReleaseNotes = lines.some((l) => l.replace(/#.*/, '').trim() === 'release-notes/');
  if (!hasReleaseNotes) {
    after = after.trimEnd() + '\nrelease-notes/\n';
  }
  if (after === before) return { status: 'skipped', notes: ['already up-to-date'] };
  if (!dryRun) writeFileSync(target, after);
  return { status: 'applied', notes: ['.indexignore updated'] };
});

// ---------- step 10: generate CLAUDE.local.md if absent ----------

const step10 = step('generate-claude-local', (root, { dryRun }) => {
  const target = join(root, 'CLAUDE.local.md');
  if (existsSync(target)) return { status: 'skipped', notes: ['already exists'] };
  const settings = join(root, '.claude', 'settings.local.json');
  if (!existsSync(settings)) return { status: 'skipped', notes: ['no settings.local.json'] };
  if (dryRun) return { status: 'applied', notes: ['would generate'] };
  try {
    const result = generateClaudeLocal(root);
    return { status: 'applied', notes: [`generated ${result.path}`] };
  } catch (e) {
    return { status: 'skipped', notes: [`could not generate: ${e.message}`] };
  }
});

// ---------- step 11: delete old generator script ----------

const step11 = step('delete-legacy-scripts', (root, { dryRun }) => {
  const oldScript = join(root, '.claude', 'scripts', 'build-shared-context-index.mjs');
  const oldTest = join(root, '.claude', 'scripts', 'build-shared-context-index.test.mjs');
  const removed = [];
  for (const f of [oldScript, oldTest]) {
    if (existsSync(f)) {
      if (!dryRun) unlinkSync(f);
      removed.push(f.replace(root + sep, ''));
    }
  }
  return removed.length > 0
    ? { status: 'applied', notes: removed.map((f) => `rm ${f}`) }
    : { status: 'skipped', notes: ['legacy scripts not present'] };
});

// ---------- step 12: regenerate auto-files ----------

const step12 = step('build-auto-files', (root, { dryRun }) => {
  if (dryRun) return { status: 'skipped', notes: ['skipped under --dry-run'] };
  if (!existsSync(join(root, NEW))) return { status: 'noop' };
  const generator = join(root, '.claude', 'scripts', 'build-workspace-context.mjs');
  if (!existsSync(generator)) {
    return { status: 'skipped', notes: ['build-workspace-context.mjs not installed yet'] };
  }
  const r = spawnSync('node', [generator, '--write', '--root', root], { encoding: 'utf-8' });
  if (r.status !== 0) {
    return {
      status: 'error',
      notes: [r.stderr.trim() || 'generator failed'],
    };
  }
  return { status: 'applied', notes: [r.stdout.trim()] };
});

const STEPS = [step1, step2, step3, step4, step5, step6, step7, step8, step9, step10, step11, step12];

function migrate(root, options = {}) {
  const absRoot = resolve(root);
  const results = [];
  for (const fn of STEPS) {
    results.push(fn(absRoot, options));
  }
  return results;
}

function main() {
  const args = parseArgs(process.argv);
  const results = migrate(args.root, { dryRun: args.dryRun });
  process.stdout.write(JSON.stringify({ root: args.root, dryRun: args.dryRun, results }, null, 2) + '\n');
  if (results.some((r) => r.status === 'error')) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`migrate-to-workspace-context: ${err.message}\n`);
    process.exit(1);
  }
}

export { migrate, STEPS, dirLooksLikeUserScope };
