#!/usr/bin/env node
// Three-way merge for the `differs` files of an upgrade payload (gh:193).
//
// classify-update.mjs files a payload file as `differs` when the workspace
// copy and the template's new copy both left the baseline — a local edit
// meeting a template change. Picking one side whole loses the other, so this
// script merges instead, using the template files of the version being
// upgraded FROM as the common ancestor. `--upgrade` stages those at
// .workspace-update/.template-base/ under live names (lib/upgrade.mjs owns
// the staging) whenever it could fetch the installed version's npm tarball;
// offline or unpublished, the base is absent and every file reports noBase.
//
// Usage:
//   node template-merge.mjs --root <dir> --payload <dir> [--baseline <file>]
//                           [--out <dir>] [--files a,b]
//
// --root     the workspace root (the update worktree in the remote flow);
//            defaults to the current working directory, never derived from
//            this script's location
// --payload  the staged payload; defaults to <root>/.workspace-update
// --baseline the baseline base content is validated against; resolves
//            exactly like classify-update's (the root's baseline first,
//            then the payload's reconstructed one) when omitted
// --out      where merged text lands, mirroring each path; defaults to
//            <payload>/.merged — NEVER the workspace file itself
// --files    a comma-separated subset of the differs list to process
//
// For each differs file, the base at <payload>/.template-base/<path> must
// exist and, when the baseline records the path, hash (template-baseline's
// hashBytes) to the baseline's entry — otherwise the file reports noBase: a
// base the baseline disproves is not this workspace's ancestor, and merging
// against it would fabricate conflicts or silently drop local edits. With a
// base, `git merge-file` merges local vs base vs template; its exit status
// is the conflict count (0 = clean merge, >0 = conflicts, anything else =
// error).
//
// Prints JSON:
//   { "merged":       [{ path, conflicts: 0, out }],
//     "conflicted":   [{ path, conflicts: N, out }],
//     "noBase":       [path],
//     "errors":       [{ path, message }],
//     "out":          "<resolved output dir>",
//     "templateBase": "<resolved base dir, or null when none was staged>" }
//
// Merged text — conflict markers `<<<<<<< local` / `>>>>>>> template`
// included — lands ONLY in the output dir. Applying an approved result is
// /workspace-update's job: copying the file into the workspace one
// operator-approved file at a time, never silently.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { classifyUpdate, resolveBaseline } from './classify-update.mjs';
import { hashBytes } from './template-baseline.mjs';

export const TEMPLATE_BASE_DIR = '.template-base';
export const MERGED_DIR = '.merged';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), payload: null, baseline: null, out: null, files: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--payload') args.payload = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--files') args.files = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

// git merge-file's exit status is the conflict count, truncated to 127; a
// status outside 0–127 (or a spawn failure, or binary input git refuses to
// merge) is an error, not a merge.
const MAX_CONFLICT_STATUS = 127;
const MERGE_BUFFER = 16 * 1024 * 1024;

function gitMergeFile(local, base, template) {
  // -p prints the merged text to stdout instead of overwriting <local> —
  // the workspace file is never touched. The -L labels name the three sides
  // in the order the files follow, so conflict hunks read
  // `<<<<<<< local` … `>>>>>>> template`.
  const r = spawnSync('git', [
    'merge-file', '-p',
    '-L', 'local', '-L', 'base', '-L', 'template',
    local, base, template,
  ], { encoding: 'utf8', maxBuffer: MERGE_BUFFER });
  if (r.error || r.status === null || r.status < 0 || r.status > MAX_CONFLICT_STATUS) {
    const detail = (r.stderr && r.stderr.trim())
      || (r.error && r.error.message)
      || `git merge-file exited with status ${r.status}`;
    return { error: detail };
  }
  return { conflicts: r.status, text: r.stdout ?? '' };
}

/**
 * Merge the payload's `differs` files three-way. Classification comes from
 * classifyUpdate (imported, not re-derived) so the merge set is exactly what
 * Step 2 of /workspace-update showed the operator. Merged text — clean or
 * conflicted — is written under `out` (default <payload>/.merged/) mirroring
 * each path; the workspace files themselves are never written here.
 */
export function mergeTemplateFiles({ root, payload = null, baseline = null, out = null, files = null }) {
  const absRoot = resolve(root);
  const absPayload = resolve(payload ?? join(absRoot, '.workspace-update'));
  if (!existsSync(absPayload)) {
    throw new Error(`No payload found at ${absPayload} — run npx @ulysses-ai/create-workspace --upgrade first`);
  }

  const classification = classifyUpdate({ root: absRoot, payload: absPayload, baseline });
  const differsSet = new Set(classification.differs);
  const baseDir = join(absPayload, TEMPLATE_BASE_DIR);

  const result = {
    merged: [],
    conflicted: [],
    noBase: [],
    errors: [],
    out: resolve(out ?? join(absPayload, MERGED_DIR)),
    templateBase: existsSync(baseDir) ? baseDir : null,
  };

  let targets = classification.differs;
  if (files !== null) {
    const wanted = files.split(',').map((s) => s.trim()).filter(Boolean);
    targets = [];
    for (const rel of wanted) {
      if (differsSet.has(rel)) targets.push(rel);
      else result.errors.push({ path: rel, message: 'not classified as differs — only differs files can be merged' });
    }
  }

  const { baseline: resolvedBaseline } = resolveBaseline({ root: absRoot, payload: absPayload, baseline });
  for (const rel of targets) {
    const local = join(absRoot, rel);
    const template = join(absPayload, rel);
    const base = join(baseDir, rel);
    if (!existsSync(local) || !existsSync(template)) {
      result.errors.push({ path: rel, message: 'local or template copy missing' });
      continue;
    }
    if (!existsSync(base)) {
      result.noBase.push(rel);
      continue;
    }
    const baselineHash = resolvedBaseline ? resolvedBaseline.files[rel] : undefined;
    if (baselineHash !== undefined && hashBytes(readFileSync(base)) !== baselineHash) {
      result.noBase.push(rel);
      continue;
    }
    const merge = gitMergeFile(local, base, template);
    if (merge.error) {
      result.errors.push({ path: rel, message: merge.error });
      continue;
    }
    const outFile = join(result.out, rel);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, merge.text);
    const entry = { path: rel, conflicts: merge.conflicts, out: outFile };
    if (merge.conflicts === 0) result.merged.push(entry);
    else result.conflicted.push(entry);
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  const result = mergeTemplateFiles(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`template-merge: ${err.message}\n`);
    process.exit(1);
  }
}
