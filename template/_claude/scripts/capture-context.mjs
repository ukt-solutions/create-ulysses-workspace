#!/usr/bin/env node
// Centralized capture helper for /braindump, /handoff, /aside, /promote.
// Mechanizes the path math, naming convention, and frontmatter so skills
// don't have to duplicate it (and can't drift from each other).
//
// Usage:
//   echo "<body>" | node capture-context.mjs \
//     --type braindump|handoff|research \
//     --topic kebab-case-slug \
//     --scope shared|team-member \
//     [--user alice]            # required when --scope team-member
//     [--description "..."]     # one-line summary, used by index
//     [--variant aside]         # arbitrary frontmatter marker
//     [--local-only]            # prefix filename with local-only- (gitignored)
//     [--update]                # overwrite if file exists; default appends -2, -3, ...
//     [--root <path>]           # workspace root (defaults to cwd)
//     [--print-only]            # don't write; just print the planned path
//
// Path layout:
//   shared scope:      workspace-context/shared/{type}_{topic}.md
//   team-member scope: workspace-context/team-member/{user}/{type}_{topic}.md
// With --local-only, the file basename is prefixed `local-only-` (e.g.
// `local-only-research_my-topic.md`), so the gitignore pattern keeps it
// out of git.
//
// Root guard: the workspace root is the launcher, and it stays on the
// repository's default branch — only local-only files are written there. A
// tracked capture committed at the root would land on that branch, so when
// --root is a git checkout sitting on its default branch the helper refuses
// a tracked capture, for --print-only as for a write. The error names the
// way out: --local-only, or a worktree — a task's or a session's — which is
// on another branch and passes. Nothing waves a capture through; what must
// be tracked is written into a worktree.
//
// The guard is a safety net behind the rule the skills state, not the rule
// itself, and it fails open. It says nothing, and the capture proceeds as if
// there were no guard, when:
//   - git is not installed or cannot answer;
//   - --root is not a git repository, or is a directory nested inside one
//     rather than its top level;
//   - HEAD is detached, on no branch;
//   - the default branch is not recognised. Only `git clone` records it, in
//     refs/remotes/origin/HEAD. A remote added by hand leaves that ref
//     unset, and `main` and `master` are then taken for the default when
//     the checkout sits on either. A default branch under any other name —
//     `trunk`, say, on a launcher whose remote was added by hand — is never
//     matched, so a tracked capture there passes.
// The skills keep every root capture local-only regardless; only a skill
// that forgets the rule is left without this backstop.
//
// Stdin: the markdown body to write under the frontmatter. Required unless
// --print-only is passed.
//
// Stdout: a single line with the absolute path of the written (or planned) file.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

const VALID_TYPES = new Set(['braindump', 'handoff', 'research']);
const VALID_SCOPES = new Set(['shared', 'team-member']);

const WC_DIR = 'workspace-context';
const SHARED_DIR = 'shared';
const TEAM_MEMBER_DIR = 'team-member';

function parseArgs(argv) {
  const args = {
    type: null,
    topic: null,
    scope: null,
    user: null,
    description: null,
    variant: null,
    localOnly: false,
    update: false,
    root: process.cwd(),
    printOnly: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') args.type = argv[++i];
    else if (a === '--topic') args.topic = argv[++i];
    else if (a === '--scope') args.scope = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--description') args.description = argv[++i];
    else if (a === '--variant') args.variant = argv[++i];
    else if (a === '--local-only') args.localOnly = true;
    else if (a === '--update') args.update = true;
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--print-only') args.printOnly = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

function validate(args) {
  if (!args.type || !VALID_TYPES.has(args.type)) {
    throw new Error(`--type must be one of: ${[...VALID_TYPES].join(', ')}`);
  }
  if (!args.topic || !/^[a-z0-9][a-z0-9-]*$/.test(args.topic)) {
    throw new Error('--topic must be kebab-case (lowercase letters, digits, hyphens)');
  }
  if (!args.scope || !VALID_SCOPES.has(args.scope)) {
    throw new Error(`--scope must be one of: ${[...VALID_SCOPES].join(', ')}`);
  }
  if (args.scope === 'team-member' && !args.user) {
    throw new Error('--user is required when --scope is team-member');
  }
  if (args.scope === 'team-member' && !/^[A-Za-z0-9_-]+$/.test(args.user)) {
    throw new Error('--user must be alphanumeric (with optional - or _)');
  }
}

function computeDir(args) {
  if (args.scope === 'shared') {
    return join(args.root, WC_DIR, SHARED_DIR);
  }
  return join(args.root, WC_DIR, TEAM_MEMBER_DIR, args.user);
}

function computeBaseFilename(args) {
  const prefix = args.localOnly ? 'local-only-' : '';
  return `${prefix}${args.type}_${args.topic}.md`;
}

function resolveCollision(dir, baseFilename, update) {
  const initial = join(dir, baseFilename);
  if (update) return initial;
  if (!existsSync(initial)) return initial;

  const dot = baseFilename.lastIndexOf('.');
  const stem = baseFilename.slice(0, dot);
  const ext = baseFilename.slice(dot);
  for (let i = 2; i < 1000; i++) {
    const candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find unique filename for ${baseFilename} (1000+ collisions)`);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function buildFrontmatter(args) {
  const fm = {
    state: 'ephemeral',
    lifecycle: 'active',
    type: args.type,
    topic: args.topic,
  };
  if (args.scope === 'team-member') fm.author = args.user;
  if (args.variant) fm.variant = args.variant;
  if (args.description) fm.description = args.description;
  fm.updated = todayISO();
  return fm;
}

function renderFrontmatter(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// One line of git's output, or null when git could not answer — it is not
// installed, there is no repository at {root}, or the ref does not resolve.
// The argument array needs no shell, so a path is never read as shell text.
function gitLine(gitFn, root, args) {
  try {
    const res = gitFn('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (!res || res.error || res.status !== 0) return null;
    return String(res.stdout).trim();
  } catch {
    return null;
  }
}

// The branch a clone of the repository at {root} would check out. Only a
// clone records it, in refs/remotes/origin/HEAD; a remote added by hand
// leaves that ref unset, and then nothing names the default. In that case
// {current} is taken for it when it is `main` or `master` — the two names
// git has used on its own — and `main` otherwise, so a default branch under
// any other name goes unrecognised and the guard fails open.
function defaultBranchOf(gitFn, root, current) {
  const remote = gitLine(gitFn, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remote) return remote.replace(/^origin\//, '');
  return current === 'main' || current === 'master' ? current : 'main';
}

/**
 * True when {root} is the top-level checkout of a git repository whose HEAD
 * is on that repository's default branch — the state the workspace launcher
 * is kept in. A task or session worktree is the same repository on another
 * branch and returns false. So does anything git cannot vouch for: no git,
 * no repository, a detached HEAD, a directory merely nested inside some
 * other repository, or a default branch that cannot be recognised.
 *
 * gitFn is injectable so tests can script git's answers; the default is
 * spawnSync, called as (command, args, options).
 */
function isDefaultBranchCheckout(root, gitFn = spawnSync) {
  // --show-prefix is empty only at a repository's top level, which tells a
  // launcher from a directory inside one without comparing paths.
  const prefix = gitLine(gitFn, root, ['rev-parse', '--show-prefix']);
  if (prefix !== '') return false;
  // symbolic-ref, not rev-parse --abbrev-ref: it names the branch before the
  // first commit too, and fails on a detached HEAD.
  const current = gitLine(gitFn, root, ['symbolic-ref', '--short', 'HEAD']);
  if (!current) return false;
  return current === defaultBranchOf(gitFn, root, current);
}

// A capture is tracked unless --local-only is passed. At the launcher that
// puts a file on the default branch at the next commit, so the helper
// refuses it here rather than trust every skill to remember the rule. There
// is no flag that waves a capture through: what must be tracked is written
// into a worktree, by passing --root.
function assertRootWriteAllowed(args, gitFn) {
  if (args.localOnly) return;
  if (!isDefaultBranchCheckout(args.root, gitFn)) return;
  throw new Error(`refusing a tracked capture in ${args.root}: that checkout is on its default branch, where only local-only files are written. Pass --local-only to keep the capture gitignored, or write it into a worktree to track it.`);
}

// Planning is where a capture's path is decided, so it is also where the
// root guard runs: --print-only reports a refusal exactly as a write does.
function plan(args, { gitFn = spawnSync } = {}) {
  validate(args);
  assertRootWriteAllowed(args, gitFn);
  const dir = computeDir(args);
  const baseFilename = computeBaseFilename(args);
  const filePath = resolveCollision(dir, baseFilename, args.update);
  return { dir, filePath, frontmatter: buildFrontmatter(args) };
}

function write(args, body, { gitFn = spawnSync } = {}) {
  const planned = plan(args, { gitFn });
  ensureDir(planned.dir);
  const content = renderFrontmatter(planned.frontmatter) + '\n\n' + body.replace(/^\n+/, '');
  const finalContent = content.endsWith('\n') ? content : content + '\n';
  writeFileSync(planned.filePath, finalContent);
  return planned.filePath;
}

function main() {
  const args = parseArgs(process.argv);
  args.root = resolve(args.root);

  if (args.printOnly) {
    const planned = plan(args);
    process.stdout.write(planned.filePath + '\n');
    return;
  }

  const body = readStdinSync();
  if (!body || !body.trim()) {
    throw new Error('No body content on stdin (use --print-only to skip writing)');
  }
  const filePath = write(args, body);
  process.stdout.write(filePath + '\n');
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`capture-context: ${err.message}\n`);
    process.exit(1);
  }
}

export {
  parseArgs,
  validate,
  computeDir,
  computeBaseFilename,
  resolveCollision,
  buildFrontmatter,
  renderFrontmatter,
  isDefaultBranchCheckout,
  plan,
  write,
};
