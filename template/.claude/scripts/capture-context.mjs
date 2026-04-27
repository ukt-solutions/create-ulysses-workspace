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
// Stdin: the markdown body to write under the frontmatter. Required unless
// --print-only is passed.
//
// Stdout: a single line with the absolute path of the written (or planned) file.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

function plan(args) {
  validate(args);
  const dir = computeDir(args);
  const baseFilename = computeBaseFilename(args);
  const filePath = resolveCollision(dir, baseFilename, args.update);
  return { dir, filePath, frontmatter: buildFrontmatter(args) };
}

function write(args, body) {
  const planned = plan(args);
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
  plan,
  write,
};
