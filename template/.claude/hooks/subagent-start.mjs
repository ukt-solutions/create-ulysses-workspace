#!/usr/bin/env node
// SubagentStart hook — give subagents the workspace's canonical truths.
//
// Subagents do not load CLAUDE.md, so without this they start with no team context.
// They do, however, get a full model context window and their own file tools, so the
// right shape is not "paste everything" — it is: inline the short constraints that
// should frame every task, and hand over a pointer for the long reference material.
// That follows the just-in-time guidance and keeps the injection stable as canon grows.
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, basename, relative, sep } from 'path';
import { getWorkspaceRoot, readJSON, respond } from './_utils.mjs';
import { readDescription, gitIgnoredPaths, stripFrontmatter } from '../scripts/build-workspace-context.mjs';

const root = getWorkspaceRoot(import.meta.url);
const config = readJSON(join(root, 'workspace.json'));
const lockedRel = 'workspace-context/shared/locked';
const lockedDir = join(root, 'workspace-context', 'shared', 'locked');

// Per-file ceiling for inlining. Files above it become pointers regardless of headroom,
// so one long document cannot crowd out every short constraint.
const inlineMax = config?.workspace?.subagentInlineMaxBytes || 8192;
// Total ceiling as a backstop. Overflow demotes the largest inlined files to pointers.
const totalMax = config?.workspace?.subagentContextMaxBytes || 32768;

if (!existsSync(lockedDir)) {
  respond();
  process.exit(0);
}

let names = [];
try {
  names = readdirSync(lockedDir).filter((f) => f.endsWith('.md') && f !== '.keep').sort();
} catch {
  respond();
  process.exit(0);
}

// canonical.md excludes gitignored files; this path must match it. Without the filter a
// local-only-*.md dropped into shared/locked/ is broadcast to every subagent.
const relPaths = names.map((n) => relative(root, join(lockedDir, n)).split(sep).join('/'));
let ignored = new Set();
try {
  ignored = gitIgnoredPaths(root, relPaths);
} catch {
  /* filter unavailable — fall through with nothing ignored */
}

const entries = [];
for (let i = 0; i < names.length; i++) {
  if (ignored.has(relPaths[i])) continue;
  const file = join(lockedDir, names[i]);
  let content = '';
  let size = 0;
  try {
    content = readFileSync(file, 'utf-8');
    size = statSync(file).size;
  } catch {
    continue;
  }
  entries.push({
    name: basename(names[i], '.md'),
    path: `${lockedRel}/${names[i]}`,
    description: readDescription(file),
    content,
    size,
    inline: size <= inlineMax,
  });
}

if (entries.length === 0) {
  respond();
  process.exit(0);
}

const render = () => {
  const inlined = entries.filter((e) => e.inline);
  const pointers = entries.filter((e) => !e.inline);
  const parts = [];
  if (inlined.length > 0) {
    parts.push('Canonical workspace context (team truths that apply to every task):');
    for (const e of inlined) parts.push(`\n--- ${e.name} (${e.path}) ---\n${stripFrontmatter(e.content).trim()}`);
  }
  if (pointers.length > 0) {
    parts.push(
      '\nAlso canonical, not inlined here — read the file if your task touches it:',
      ...pointers.map((e) => `- ${e.name} — ${e.description} [${e.path}, ${e.size} bytes]`),
    );
  }
  return parts.join('\n');
};

// Demote largest-first until the total fits. Short constraints survive; long reference
// material degrades to a pointer, which is what it should have been anyway.
let out = render();
while (
  Buffer.byteLength(out) > totalMax &&
  entries.some((e) => e.inline)
) {
  const biggest = entries.filter((e) => e.inline).sort((a, b) => b.size - a.size)[0];
  biggest.inline = false;
  out = render();
}

respond(out);
