#!/usr/bin/env node
// Unit tests for payload.mjs
// Run: node lib/payload.test.mjs
//
// The staged .workspace-update/ payload is an on-disk format shared with
// the /workspace-update skill already installed in existing workspaces,
// which reads .workspace-update/.claude/... and .workspace-update/.mcp.json.
// These tests pin that layout even though template/ itself stores the
// protected paths under the inert names _claude/ and _mcp.json. The
// published-tarball reader (baseline reconstruction's input) is covered
// here too, against fixture tarballs built in-memory — no network.
import { stagePayload, cleanPayload, extractTarballEntries, fetchPackageTarball } from './payload.mjs';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gzipSync } from 'zlib';

let failed = 0;
let passed = 0;
function check(label, ok) {
  if (ok) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'payload-test-'));

try {
  const { payloadDir, toVersion } = stagePayload(root, { action: 'init' });

  check('payload staged at .workspace-update/', existsSync(payloadDir));
  check('manifest written', existsSync(join(payloadDir, '.manifest.json')));
  check('returns the package version', typeof toVersion === 'string' && toVersion.length > 0);

  // The payload keeps the live names older workspaces' skills expect
  check('.claude/ staged under live name', existsSync(join(payloadDir, '.claude')));
  check('.claude/skills/workspace-update/SKILL.md staged', existsSync(join(payloadDir, '.claude', 'skills', 'workspace-update', 'SKILL.md')));
  check('.claude/settings.json staged', existsSync(join(payloadDir, '.claude', 'settings.json')));
  check('.mcp.json staged under live name', existsSync(join(payloadDir, '.mcp.json')));
  check('_gitignore stays inert (skills merge it under that name)', existsSync(join(payloadDir, '_gitignore')));

  // The template's inert names must not leak into the payload
  check('no _claude/ in payload', !existsSync(join(payloadDir, '_claude')));
  check('no _mcp.json in payload', !existsSync(join(payloadDir, '_mcp.json')));

  // cleanPayload removes the staging directory
  cleanPayload(root);
  check('cleanPayload removes .workspace-update/', !existsSync(payloadDir));
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ---- extractTarballEntries ----

// Minimal ustar writer: 512-byte header + padded body, matching what npm's
// tarballs carry for paths under 100 chars.
function tarEntry(name, content, type = '0') {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

function makeTarball(entries) {
  return gzipSync(Buffer.concat([
    ...entries.map(([name, content, type]) => tarEntry(name, content, type)),
    Buffer.alloc(1024),
  ]));
}

// A GNU long-name record ('L') followed by the entry it names.
function makeTarballWithLongName(longPath, content) {
  const blocks = [
    tarEntry('././@LongLink', longPath, 'L'),
    tarEntry(longPath.slice(0, 20), content),
    Buffer.alloc(1024),
  ];
  return gzipSync(Buffer.concat(blocks));
}

// A PAX extended header ('x') carrying a path override, then the entry.
function makeTarballWithPaxPath(path, content) {
  const record = `${path.length + 20} path=${path}\n`;
  const blocks = [
    tarEntry('PaxHeaders/x', record, 'x'),
    tarEntry('short-name', content),
    Buffer.alloc(1024),
  ];
  return gzipSync(Buffer.concat(blocks));
}

{
  const dest = mkdtempSync(join(tmpdir(), 'payload-tar-'));
  try {
    const files = extractTarballEntries(makeTarball([
      ['template/_claude/hooks/a.mjs', '// a\n'],
      ['template/_claude/rules', '', '5'],
      ['template/_mcp.json', '{"mcpServers":{}}\n'],
      ['template/.claudeignore', 'scratch/\n'],
      ['package/package.json', '{"version":"9.9.9"}\n'],
      ['README.md', 'not under the prefix\n'],
    ]), dest, { prefix: 'template/' });
    check('extracts the three prefixed files', files === 3);
    check('nested file content round-trips',
      readFileSync(join(dest, '_claude', 'hooks', 'a.mjs'), 'utf8') === '// a\n');
    check('directory entry materializes', existsSync(join(dest, '_claude', 'rules')));
    check('entries outside the prefix are not extracted',
      !existsSync(join(dest, '..', 'package')) && !existsSync(join(dest, 'package')));
    check('unprefixed top-level files are not extracted', !existsSync(join(dest, 'README.md')));

    // A traversal attempt inside the prefix is skipped, not written.
    const guardDest = mkdtempSync(join(tmpdir(), 'payload-tar-'));
    extractTarballEntries(makeTarball([
      ['template/../escape.txt', 'nope\n'],
      ['template/ok.txt', 'fine\n'],
    ]), guardDest, { prefix: 'template/' });
    check('.. paths are refused', !existsSync(join(guardDest, '..', 'escape.txt')));
    check('sibling of .. entry still extracted', existsSync(join(guardDest, 'ok.txt')));
    rmSync(guardDest, { recursive: true, force: true });

    // GNU long names and PAX path overrides both resolve to the real name.
    const longPath = `template/_claude/scripts/${'very-long-name-'.repeat(8)}.mjs`;
    const longDest = mkdtempSync(join(tmpdir(), 'payload-tar-'));
    extractTarballEntries(makeTarballWithLongName(longPath, '// long\n'), longDest, { prefix: 'template/' });
    check('GNU long-name entries extract under their full path',
      readFileSync(join(longDest, '_claude', 'scripts', `${'very-long-name-'.repeat(8)}.mjs`), 'utf8') === '// long\n');
    rmSync(longDest, { recursive: true, force: true });

    const paxDest = mkdtempSync(join(tmpdir(), 'payload-tar-'));
    extractTarballEntries(makeTarballWithPaxPath('template/_claude/pax.mjs', '// pax\n'), paxDest, { prefix: 'template/' });
    check('PAX path overrides extract under the overridden path',
      readFileSync(join(paxDest, '_claude', 'pax.mjs'), 'utf8') === '// pax\n');
    rmSync(paxDest, { recursive: true, force: true });

    // A PAX override that belongs to a NON-file entry (a symlink) dies with
    // it: the file after the link extracts under its own header name, never
    // under the leaked override.
    const leakDest = mkdtempSync(join(tmpdir(), 'payload-tar-'));
    const record = `${'template/_claude/leaked.mjs'.length + 20} path=template/_claude/leaked.mjs\n`;
    extractTarballEntries(makeTarball([
      ['PaxHeaders/x', record, 'x'],
      ['target', 'template/elsewhere.mjs', '2'],
      ['template/_claude/own-name.mjs', '// own\n'],
    ]), leakDest, { prefix: 'template/' });
    check('a PAX name followed by a non-file entry does not leak',
      !existsSync(join(leakDest, '_claude', 'leaked.mjs'))
      && !existsSync(join(leakDest, '_claude', 'elsewhere.mjs')));
    check('the entry after a discarded override uses its own name',
      readFileSync(join(leakDest, '_claude', 'own-name.mjs'), 'utf8') === '// own\n');
    rmSync(leakDest, { recursive: true, force: true });

    // Tar names written on Windows carry '\' separators — treated as
    // directory separators like '/'.
    const bsDest = mkdtempSync(join(tmpdir(), 'payload-tar-'));
    extractTarballEntries(makeTarball([
      ['template\\_claude\\hooks\\win.mjs', '// win\n'],
    ]), bsDest, { prefix: 'template/' });
    check('backslash-separated entry names extract as directories',
      readFileSync(join(bsDest, '_claude', 'hooks', 'win.mjs'), 'utf8') === '// win\n');
    rmSync(bsDest, { recursive: true, force: true });
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

// fetchPackageTarball rejects non-semver versions before any network or
// npm call — a workspace.json value is user input.
{
  const bogus = await fetchPackageTarball('0.15.0; rm -rf /');
  check('non-semver version fetches nothing', bogus === null);
  const alsoBogus = await fetchPackageTarball('');
  check('empty version fetches nothing', alsoBogus === null);
}

// The registry fetch is bounded: a hung connection must not stall an
// upgrade indefinitely (reconstruction falls back to asking per file).
{
  const realFetch = globalThis.fetch;
  const tarball = makeTarball([['package/template/.claudeignore', 'x/\n']]);
  let seenInit = null;
  globalThis.fetch = async (url, init) => {
    seenInit = { url, init };
    return { ok: true, arrayBuffer: async () => tarball };
  };
  try {
    const bytes = await fetchPackageTarball('0.15.0');
    check('registry fetch returns the tarball bytes', bytes !== null && bytes.equals(tarball));
    check('registry fetch targets the versioned tarball URL',
      seenInit !== null && seenInit.url.endsWith('/create-workspace-0.15.0.tgz'));
    check('registry fetch carries an abort timeout signal',
      seenInit !== null && seenInit.init?.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
