#!/usr/bin/env node
// Maps the git tag that triggered the publish workflow to the npm dist-tag
// the release is published under, and refuses every tag it does not know.
//
//   tag                dist-tag    release
//   vX.Y.Z             latest      stable
//   vX.Y.Z-beta.<n>    beta        pre-release
//   vX.Y.Z-rc.<n>      rc          pre-release
//   vX.Y.Z-canary.<n>  canary      pre-release
//   vX.Y.Z-next.<n>    next        pre-release
//
// X, Y, Z and n are decimal numbers without leading zeros (`0` itself is
// allowed), and the leading `v` is optional. A pre-release publishes under
// its own identifier because an installed package reads its channel back off
// its version and compares against the dist-tag of that name
// (template/_claude/lib/registry-check.mjs).
//
// An unknown or malformed tag fails the publish instead of falling through
// to `latest`. A fall-through is wrong in the one direction that cannot be
// undone: `latest` is what a bare `npx @ulysses-ai/create-workspace`
// installs. A suffix such as `-alpha.1`, or a `-rc` with no counter, is a
// mistake in the tag, and the failed run reports it before anything is
// installed or published.
//
// Usage:
//   import { distTagFor, PRERELEASE_CHANNELS } from './dist-tag.mjs'
//   node scripts/dist-tag.mjs <tag>
//
// The CLI prints `dist=<dist-tag>` and `is_prerelease=<true|false>`, the two
// lines the publish workflow appends to $GITHUB_OUTPUT, and exits 0. With
// anything other than exactly one accepted tag as its argument, it prints
// the reason to stderr, nothing to stdout, and exits 1. scripts/ is not part
// of the published package.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Each channel is both the pre-release identifier in the version
// (`1.0.0-rc.0`) and the dist-tag it publishes under. Frozen because the
// pattern and the error message are both built from it: a channel pushed
// later would be promised by the message and still rejected by the pattern.
export const PRERELEASE_CHANNELS = Object.freeze(['beta', 'rc', 'canary', 'next']);

// A decimal number without leading zeros; `0` itself is allowed.
const NUMBER = String.raw`(?:0|[1-9][0-9]*)`;

// The whole tag and nothing but the tag: anchored at both ends, with no `m`
// flag, so a trailing newline or a fourth number is a mismatch. Group 1 is
// the pre-release channel, undefined for a bare release.
const RELEASE_TAG = new RegExp(
  String.raw`^v?${NUMBER}\.${NUMBER}\.${NUMBER}(?:-(${PRERELEASE_CHANNELS.join('|')})\.${NUMBER})?$`,
);

const ACCEPTED_FORMS = 'vX.Y.Z (a release, published as latest) or '
  + 'vX.Y.Z-<channel>.<n> (a pre-release, published as <channel>), where <channel> is one of '
  + `${PRERELEASE_CHANNELS.join(', ')} and <n> is a whole number`;

// `{ dist, isPrerelease }` for a release tag, with or without its leading
// `v`. Throws for anything else.
export function distTagFor(tag) {
  const match = typeof tag === 'string' ? RELEASE_TAG.exec(tag) : null;
  if (!match) {
    throw new Error(`Unrecognized release tag ${JSON.stringify(tag)}. Accepted forms: ${ACCEPTED_FORMS}`);
  }
  return match[1]
    ? { dist: match[1], isPrerelease: true }
    : { dist: 'latest', isPrerelease: false };
}

// import.meta.url resolves to the real file while argv[1] keeps the path as
// typed, so through a symlinked checkout the two differ. Compare real paths:
// a run not recognised as a direct one would exit 0 without printing a
// dist-tag.
function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

function main(argv) {
  const [tag, ...extra] = argv;
  try {
    if (tag === undefined || extra.length > 0) {
      throw new Error(`usage: node scripts/dist-tag.mjs <tag> — exactly one argument. Accepted forms: ${ACCEPTED_FORMS}`);
    }
    const { dist, isPrerelease } = distTagFor(tag);
    process.stdout.write(`dist=${dist}\nis_prerelease=${isPrerelease}\n`);
  } catch (err) {
    // exitCode, not exit(): a write to a pipe may still be pending, and
    // exit() can end the process before it is flushed.
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
