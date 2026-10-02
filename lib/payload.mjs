// lib/payload.mjs
import {
  existsSync, cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, renameSync,
  mkdtempSync, readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { gunzipSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', 'template');

export function getTemplateVersion() {
  return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version;
}

export function stagePayload(targetDir, { action, fromVersion = null }) {
  const payloadDir = join(targetDir, '.workspace-update');
  const toVersion = getTemplateVersion();

  // Clean any existing payload
  if (existsSync(payloadDir)) {
    rmSync(payloadDir, { recursive: true });
  }

  // Copy template to payload directory
  cpSync(TEMPLATE_DIR, payloadDir, { recursive: true });

  // The template stores .claude/ and .mcp.json under the inert names
  // _claude/ and _mcp.json (Claude Code protects the live names from
  // headless edits). The staged payload is an on-disk format shared with
  // the /workspace-update skill ALREADY INSTALLED in the workspace, which
  // reads .workspace-update/.claude/... — so it must keep the live names
  // exactly as older package versions staged them. _gitignore stays inert:
  // the skills have always merged it under that name.
  for (const [from, to] of [
    ['_claude', '.claude'],
    ['_mcp.json', '.mcp.json'],
  ]) {
    const src = join(payloadDir, from);
    if (existsSync(src)) {
      renameSync(src, join(payloadDir, to));
    }
  }

  // Write manifest
  const manifest = {
    action,
    templateVersion: toVersion,
    timestamp: new Date().toISOString(),
    source: '@ulysses-ai/create-workspace',
  };
  if (fromVersion) manifest.fromVersion = fromVersion;

  writeFileSync(join(payloadDir, '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  return { payloadDir, toVersion, fromVersion };
}

export function cleanPayload(targetDir) {
  const payloadDir = join(targetDir, '.workspace-update');
  if (existsSync(payloadDir)) {
    rmSync(payloadDir, { recursive: true });
  }
}

// ---------- published-tarball reader ----------
//
// Baseline reconstruction (lib/upgrade.mjs) needs the template tree of an
// OLDER published version, and the npm registry is the only place that
// still has it. Node ships no tar module and the package takes no
// dependencies, so what follows is a minimal reader for the tar variants
// npm actually writes: ustar headers, PAX extended headers ('x'), and GNU
// long names ('L'). Links and devices are skipped — the template is plain
// files and directories.

const TAR_BLOCK = 512;

function tarString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? length : nul).toString('utf8');
}

function tarSize(header) {
  // GNU tar sets the high bit and switches to base-256 once a size no
  // longer fits octal; npm's tarballs stay far below that, but reading
  // the flag is two lines and keeps the reader from truncating silently.
  if (header[124] & 0x80) {
    let value = 0n;
    for (let i = 125; i < 136; i++) value = (value << 8n) | BigInt(header[i]);
    return Number(value);
  }
  const s = tarString(header, 124, 12).trim();
  return s === '' ? 0 : parseInt(s, 8);
}

function ustarName(header) {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

// A version that can name a real published tarball. It comes from the
// workspace's own workspace.json, so anything that is not plain semver is
// rejected before it reaches a URL or an npm argument.
function isVersionString(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version);
}

/**
 * Extract every entry under `prefix` (e.g. 'template/') from a gzipped
 * tarball into `destDir`, returning the number of files written. Entries
 * that would escape destDir (absolute paths, '..') are skipped — the
 * tarball comes from the npm registry, but the guard costs one line.
 */
export function extractTarballEntries(tarballBytes, destDir, { prefix = '' } = {}) {
  const tar = gunzipSync(tarballBytes);
  let files = 0;
  let pendingName = null; // set by a preceding GNU 'L' or PAX 'x' entry
  for (let off = 0; off + TAR_BLOCK <= tar.length;) {
    const header = tar.subarray(off, off + TAR_BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const size = tarSize(header);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = off + TAR_BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (type === 'L') {
      pendingName = tarString(data, 0, data.length);
    } else if (type === 'x') {
      // PAX records are "<length> key=value" lines; only the path override
      // matters here.
      const m = data.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]+)/);
      if (m) pendingName = m[1];
    } else if (type === '5') {
      const name = pendingName !== null ? pendingName : ustarName(header);
      pendingName = null;
      if (name.startsWith(prefix)) {
        const rel = name.slice(prefix.length);
        if (rel !== '' && !rel.startsWith('/') && !rel.split('/').includes('..')) {
          mkdirSync(join(destDir, rel), { recursive: true });
        }
      }
    } else if (type === '0') {
      const name = pendingName !== null ? pendingName : ustarName(header);
      pendingName = null;
      if (!name.startsWith(prefix)) continue;
      const rel = name.slice(prefix.length);
      if (rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) continue;
      const dest = join(destDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      files++;
    }
    // Everything else — links, devices, fifos, global PAX — never appears
    // in an npm tarball of this package; skip without consuming the name.
  }
  return files;
}

/**
 * Fetch the published package tarball for `version` as bytes, or null when
 * it cannot be fetched. The registry URL needs no subprocess and works on
 * every platform; `npm pack` is the fallback because it honors the user's
 * configured registry and auth.
 */
export async function fetchPackageTarball(version, { registry = process.env.NPM_CONFIG_REGISTRY } = {}) {
  if (!isVersionString(version)) return null;
  const base = (registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/@ulysses-ai/create-workspace/-/create-workspace-${version}.tgz`);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  } catch { /* offline, blocked host, no fetch — try npm pack */ }
  return npmPackTarball(version);
}

function npmPackTarball(version) {
  const dest = mkdtempSync(join(tmpdir(), 'create-workspace-pack-'));
  try {
    const r = spawnSync('npm', [
      'pack', `@ulysses-ai/create-workspace@${version}`, '--pack-destination', dest, '--json',
    ], { encoding: 'utf-8' });
    if (r.error || r.status !== 0) return null;
    let name = null;
    try {
      const parsed = JSON.parse(r.stdout);
      name = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
    } catch { /* older npm prints a bare filename line — take the directory listing */ }
    const candidates = name
      ? [join(dest, name)]
      : readdirSync(dest).filter((f) => f.endsWith('.tgz')).map((f) => join(dest, f));
    for (const path of candidates) {
      if (existsSync(path)) return readFileSync(path);
    }
    return null;
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}
