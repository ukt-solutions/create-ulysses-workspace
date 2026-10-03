#!/usr/bin/env node
// Classify an upgrade payload's files against the workspace so /workspace-update
// can batch the safe cases and ask only where a decision is needed.
//
// Usage:
//   node classify-update.mjs [--root <dir>] [--payload <dir>] [--baseline <file>]
//   node classify-update.mjs --root <dir> --payload <dir> --write-baseline
//   node classify-update.mjs --root <dir> --payload <dir> --merge-claude-md
//
// --root     workspace root; defaults to the current working directory (never
//            derived from this script's location — the upgrade payload runs
//            this file from <workspace>/.workspace-update/.claude/scripts/)
// --payload  the staged payload; defaults to <root>/.workspace-update
// --baseline the baseline to classify against; defaults to
//            <root>/.claude/.template-baseline.json, falling back to
//            <payload>/.template-baseline.reconstructed.json (what --upgrade
//            reconstructs for pre-baseline workspaces) when the root has none.
//            Pass it explicitly in the worktree flow, where <root> is the
//            worktree and the launcher's baseline may not be reachable.
//
// The default mode prints JSON with these lists:
//   new        — no installed counterpart and no baseline entry; safe to
//                batch-apply after one confirm
//   identical  — installed file already equals the payload
//   updated    — installed file equals the BASELINE (what the template last
//                shipped here) but not the payload: a pure template change the
//                user never touched. Batched with `new` behind one confirm.
//   differs    — installed file matches neither the payload nor the baseline
//                while the payload also differs from the baseline: a local
//                edit AND a template change — the one case that needs a
//                per-file decision (or the workspace predates baselines and
//                has no entry to compare).
//   config     — .mcp.json and .claude/settings.json: JSON the workspace
//                owns jointly with the template (its own MCP servers and
//                settings live beside template keys). Never classified by
//                content and never batch-copied — instead each entry carries
//                a key-level diff (`added` keys the template ships, keys
//                `workspaceOnly`, keys `changed` in both, nested paths joined
//                with '/'), and /workspace-update merges key by key: add
//                template keys, keep workspace-only keys, ask on conflicting
//                keys. Array-valued keys (hooks event lists,
//                permissions.allow/deny) diff by ELEMENT instead of whole:
//                each `arrays` entry is { path, added, workspaceOnly } with
//                the element lists, and the skill merges arrays as a union —
//                the workspace's elements kept, the template's new ones
//                appended — so only true scalar conflicts ask. Entries flag
//                `notInstalled` (no workspace file — ask once whether to
//                install the payload's copy) or `unparseable` (broken JSON on
//                either side — ask, never merge blind).
//   localOnly  — installed file differs from the payload, but the payload
//                equals the baseline: the template hasn't touched the file
//                since the last update, so the difference is purely local.
//                Listed for information only — never asked about, never
//                applied.
//   deletedLocally — the baseline records the file and the payload still
//                ships it, but it is missing from the workspace: deleted
//                locally (or never installed at /workspace-init). The skill
//                asks once whether to restore the list.
//   activated  — the payload ships rules/{name}.md.skip while the workspace
//                deliberately keeps {name}.md active; nothing to install, the
//                active rule stays (gh:180)
//   removed    — installed file with no payload counterpart: the template
//                stopped shipping it. Excludes what the workspace owns:
//                the config files above (the template dropping one hands it
//                to the workspace, it never deletes user content),
//                *.test.mjs (see staleTests), anything gitignored
//                (machine-local), paths under .claude/worktrees/,
//                .claude/template-modifications.json (the workspace's own
//                registry, never shipped), and the registry's `localFiles`
//                entries (.claude/-relative paths or globs for files this
//                workspace owns; the legacy workspace.json →
//                workspace.localFiles array still counts, gh:180/gh:194).
//                Two markers refine the per-file offer
//                (gh:190): `{ file, referencedBy }` — a removed hook that a
//                workspace-only settings.json entry still registers (the
//                config-diff paths); the skill removes file and settings
//                entry together. `{ file, userOwned: true }` — no baseline
//                entry, so the template never shipped it: the workspace's
//                own, offered a workspace.localFiles entry, not deletion.
//   staleTests — *.test.mjs files under .claude/ with no payload counterpart.
//                The npm tarball ships no tests, so these came from a dev
//                checkout and are never updated by /workspace-update; the
//                skill offers to remove them (tests live in the template repo)
//   implicitDefaults — workspace.json keys whose ABSENCE carried a default
//                in the version being upgraded FROM but not in the payload's:
//                canonicalBudgetBytes meant a 40960-byte budget when absent
//                from v0.15.0-beta.1 until v0.19.0-beta.0 made it opt-in
//                (absent since means off; before v0.15 there was no budget).
//                An upgrade from inside that window into a workspace.json
//                without the key reports { key, value, reason } so the skill
//                writes the value explicitly (gh:190).
//   staleModifications — registry entries whose installed file now equals
//                the payload: the workspace already took the template's
//                version, so the recorded reason describes nothing. Each
//                reports { file, reason } so the skill can offer dropping
//                the entry (gh:194).
//   legacyKeys — template-modification data still sitting in workspace.json
//                (`workspace.localFiles`, `workspace.templateModifications`)
//                instead of .claude/template-modifications.json; the skill
//                offers the migration (gh:194).
//
// Entries in differs, localOnly, deletedLocally, and removed carry the
// workspace's registered modification reason (gh:194): a path listed in
// .claude/template-modifications.json's `modifications` map (read through
// template-modifications.mjs, which also honors the legacy workspace.json
// keys for one release) becomes { file, reason } in those lists — reason
// undefined entries stay plain paths, and a removed entry's existing
// referencedBy/userOwned markers keep their fields alongside `reason`.
// `modificationsError`, present only when the registry file doesn't parse,
// names the parse error: reasons and localFiles exclusions from the file are
// then unavailable (legacy keys still apply), and every per-file decision
// still asks — nothing is applied silently.
//
// Plus `hasBaseline`: whether a usable baseline was found, `baselineSource`
// (which file it came from) and `baselineReconstructed`. The default
// resolution is <root>/.claude/.template-baseline.json, then the payload's
// .template-baseline.reconstructed.json (both unparseable-as-absent); without
// either, template changes cannot be told from local edits, so they land in
// `differs` — the first update asks per file; once it writes the baseline,
// later updates won't.
//
// Content comparisons hash with CRLF normalized to LF on both sides (binary
// files hash byte-exact), so a git autocrlf checkout that stores CRLF where
// the payload ships LF classifies as identical rather than locally modified.
//
// Only verbatim-installed files are classified: everything under .claude/
// except .claude/settings.json, plus .mcp.json and .claudeignore — the two
// JSON configs route to `config` instead of the content lists. The payload's
// templates (*.tmpl, which install with {{project-name}} substitution),
// _gitignore (merged line-by-line into the workspace's .gitignore), and
// .manifest.json (payload metadata) are handled by their own steps in
// /workspace-update and are excluded here.
//
// The other two modes are /workspace-update bookends:
//   --write-baseline  write .claude/.template-baseline.json recording the
//                     hash of every verbatim payload file — what the template
//                     now ships. Run at the END of an update, after all
//                     per-file decisions. Entries record the PAYLOAD hash —
//                     except unapplied updates (workspace still holds the old
//                     baseline content), which keep the old entry so they
//                     present as `updated` again next time; see
//                     template-baseline.mjs. Throws rather than writing an
//                     empty baseline.
//   --merge-claude-md print JSON { claudeMd, missingIncludes }: CLAUDE.md
//                     with the payload's CLAUDE.md.tmpl merged in — template
//                     lines updated, the workspace's own lines (custom skill
//                     entries, sections) kept — plus the `@{path}` include
//                     lines the merged file carries whose targets don't
//                     exist at the root (machine-local local-only-* targets
//                     exempt). The skill shows the diff against the current
//                     file before writing, and asks on each missing include
//                     instead of leaving it dangling (gh:190).

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitIgnoredPaths } from './build-workspace-context.mjs';
import { compareVersions } from '../lib/registry-check.mjs';
import {
  BASELINE_PATH,
  RECONSTRUCTED_BASELINE_NAME,
  hashBytes,
  readBaselineFile,
  writeBaseline,
} from './template-baseline.mjs';
import {
  readTemplateModifications,
  TEMPLATE_MODIFICATIONS_PATH,
} from './template-modifications.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), payload: null, baseline: null, writeBaseline: false, mergeClaudeMd: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--payload') args.payload = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--write-baseline') args.writeBaseline = true;
    else if (a === '--merge-claude-md') args.mergeClaudeMd = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

// Payload-relative paths that install verbatim at the same relative path.
// Everything else in the payload is a template or metadata handled elsewhere.
const VERBATIM_ROOTS = ['.claude', '.mcp.json', '.claudeignore'];

// JSON configs the workspace owns jointly with the template: its own MCP
// servers sit inside .mcp.json's mcpServers, its own settings beside the
// template's keys in .claude/settings.json. Content classification would
// file every one of them as `differs` the moment the workspace adds
// anything, and a batch copy would wipe the workspace's entries — so they
// are reported in `config` with a key-level diff and merged key by key,
// never compared by bytes and never copied wholesale (gh:186).
const CONFIG_PATHS = new Set(['.mcp.json', '.claude/settings.json']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Key-level diff between the payload's config object and the workspace's.
 * Paths join keys with '/' (mcpServers/playwright) and stop at two
 * segments: these configs are maps of named units — mcpServers/{server},
 * permissions/{allow} — and a unit's own internals (a server's args vs
 * command) merge as one decision, not as separate asks. Arrays the key
 * carries on both sides diff by ELEMENT (a union merge needs no decision),
 * and any other non-object value compares by JSON value and reports at its
 * unit's path.
 */
const CONFIG_DIFF_DEPTH = 2;

function arrayElementDiff(payloadArr, workspaceArr) {
  const wsSet = new Set(workspaceArr.map((e) => JSON.stringify(e)));
  const plSet = new Set(payloadArr.map((e) => JSON.stringify(e)));
  return {
    added: payloadArr.filter((e) => !wsSet.has(JSON.stringify(e))),
    workspaceOnly: workspaceArr.filter((e) => !plSet.has(JSON.stringify(e))),
  };
}

function configKeyDiff(payloadObj, workspaceObj, prefix = '') {
  const added = [];
  const workspaceOnly = [];
  const changed = [];
  const arrays = [];
  const keys = new Set([...Object.keys(payloadObj), ...Object.keys(workspaceObj)]);
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}/${key}` : key;
    const inPayload = Object.prototype.hasOwnProperty.call(payloadObj, key);
    const inWorkspace = Object.prototype.hasOwnProperty.call(workspaceObj, key);
    if (inPayload && !inWorkspace) { added.push(path); continue; }
    if (!inPayload && inWorkspace) { workspaceOnly.push(path); continue; }
    const pv = payloadObj[key];
    const wv = workspaceObj[key];
    if (
      prefix.split('/').filter(Boolean).length + 1 < CONFIG_DIFF_DEPTH
      && isPlainObject(pv) && isPlainObject(wv)
    ) {
      const sub = configKeyDiff(pv, wv, path);
      added.push(...sub.added);
      workspaceOnly.push(...sub.workspaceOnly);
      changed.push(...sub.changed);
      arrays.push(...sub.arrays);
    } else if (Array.isArray(pv) && Array.isArray(wv)) {
      // An array both sides hold is a set the workspace extends: element
      // lists let the skill union-merge instead of choosing one side whole.
      const diff = arrayElementDiff(pv, wv);
      if (diff.added.length > 0 || diff.workspaceOnly.length > 0) {
        arrays.push({ path, ...diff });
      }
    } else if (JSON.stringify(pv) !== JSON.stringify(wv)) {
      changed.push(path);
    }
  }
  return { added, workspaceOnly, changed, arrays };
}

/**
 * One `config` entry: the key-level diff for a payload-shipped config file
 * against the workspace's copy, or a flag when no diff is possible —
 * `notInstalled` (no workspace file; the skill asks once whether to install
 * the payload's copy) and `unparseable` (broken JSON on either side; the
 * skill asks rather than merging blind).
 */
function configEntry(absRoot, absPayload, rel) {
  let payloadJson;
  try {
    payloadJson = JSON.parse(readFileSync(join(absPayload, rel), 'utf8'));
  } catch {
    return { path: rel, unparseable: true };
  }
  if (!isPlainObject(payloadJson)) return { path: rel, unparseable: true };
  const installed = join(absRoot, rel);
  if (!existsSync(installed)) return { path: rel, notInstalled: true };
  let workspaceJson;
  try {
    workspaceJson = JSON.parse(readFileSync(installed, 'utf8'));
  } catch {
    return { path: rel, unparseable: true };
  }
  if (!isPlainObject(workspaceJson)) return { path: rel, unparseable: true };
  return { path: rel, ...configKeyDiff(payloadJson, workspaceJson) };
}

function isClassified(payloadRelPath) {
  const first = payloadRelPath.split('/')[0];
  return VERBATIM_ROOTS.includes(first);
}

// Directories never walked when looking for removed files. .claude/worktrees/
// holds entire nested worktrees — walking them is slow and every file inside
// is unmanaged by the template.
const SKIPPED_DIRS = new Set(['worktrees']);

function* walkFiles(dir, prefix = '', skipDirs = null) {
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (skipDirs && skipDirs.has(name)) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(full, rel, skipDirs);
    else if (st.isFile()) yield rel;
  }
}

// Installed files under the verbatim-managed roots: the .claude/ tree (minus
// skipped directories) plus the two standalone files. Nothing else in the
// workspace root is walked — repos/ and work-sessions/ hold entire worktrees
// the template never manages.
function* walkInstalledFiles(absRoot) {
  yield* walkFiles(join(absRoot, '.claude'), '.claude', SKIPPED_DIRS);
  for (const name of ['.mcp.json', '.claudeignore']) {
    if (existsSync(join(absRoot, name))) yield name;
  }
}

/**
 * The workspace's template-modification registry (gh:194), read through
 * template-modifications.mjs: localFiles exclusions, registered modification
 * reasons, the legacy workspace.json keys still present, and a parse error
 * when the registry file is broken. See that module for the shape and the
 * one-release legacy fallback.
 */

/**
 * A classification path's registered modification reason, or undefined.
 * Registry keys are .claude/-relative, so only paths under .claude/ can be
 * registered — .mcp.json and .claudeignore live outside it and route to
 * their own lists anyway.
 */
function registeredReason(modifications, rel) {
  if (!rel.startsWith('.claude/')) return undefined;
  const reason = modifications[rel.slice('.claude/'.length)];
  return typeof reason === 'string' ? reason : undefined;
}

/** Attach registered reasons to a list of plain-path entries (gh:194). */
function withReasons(list, modifications) {
  return list.map((rel) => {
    const reason = registeredReason(modifications, rel);
    return reason === undefined ? rel : { file: rel, reason };
  });
}

/**
 * Match `rel` (a .claude/-relative posix path) against a localFiles entry —
 * an exact path or a glob where `**` spans separators and `*` does not.
 * No glob library: the shapes localFiles needs are these two stars.
 */
function globMatches(pattern, rel) {
  if (pattern === rel) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(
    `^${pattern.split('**').map(
      (part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
    ).join('.*')}$`,
  );
  return re.test(rel);
}

function isOwnedByWorkspace(rel, localFiles) {
  // The template's own .gitignore declares these machine-local; the baseline
  // is per-workspace state the template never ships.
  if (rel === '.claude/settings.local.json' || rel === '.claude/.active-session.json' || rel === BASELINE_PATH) {
    return true;
  }
  // The template-modification registry is workspace-owned state the template
  // never ships — like the baseline, its absence from the payload is not a
  // removal (gh:194).
  if (rel === TEMPLATE_MODIFICATIONS_PATH) return true;
  if (!rel.startsWith('.claude/')) return false;
  const claudeRel = rel.slice('.claude/'.length);
  return localFiles.some((pattern) => globMatches(pattern, claudeRel));
}

/**
 * Which baseline the classification runs against. An explicit --baseline
 * wins; otherwise the workspace's own <root>/.claude/.template-baseline.json
 * is tried first, then the payload's .template-baseline.reconstructed.json
 * (staged by --upgrade for workspaces that predate baselines). The fallback
 * matters in the worktree flow: <root> is the task worktree, which cannot
 * see launcher-only files, while the payload travels there by absolute path.
 * A file that exists but does not parse counts as absent — a corrupt
 * baseline must not block the reconstructed one (gh:186).
 */
export function resolveBaseline({ root, payload, baseline = null }) {
  const candidates = baseline !== null
    ? [{ path: resolve(baseline), label: baseline }]
    : [
      { path: join(resolve(root), BASELINE_PATH), label: BASELINE_PATH },
      { path: join(resolve(payload), RECONSTRUCTED_BASELINE_NAME), label: `.workspace-update/${RECONSTRUCTED_BASELINE_NAME}` },
    ];
  for (const candidate of candidates) {
    const parsed = readBaselineFile(candidate.path);
    if (parsed !== null) return { baseline: parsed, source: candidate.label };
  }
  return { baseline: null, source: null };
}

/**
 * workspace.json keys whose absence carried a default in the version being
 * upgraded FROM but not in the payload's. The canonical budget existed as an
 * implicit default only between v0.15.0-beta.1 (gh:97, which introduced it:
 * absent meant a 40960-byte budget) and v0.19.0-beta.0 (gh:164, which made
 * it opt-in: absent means off since). Before v0.15 there was no budget at
 * all, so a workspace upgrading from there also has none to preserve —
 * reporting the key would turn trimming ON. Only an upgrade from inside
 * that window into a workspace.json that never wrote the key reports it,
 * and the skill writes the explicit value and says so (gh:190).
 */
const CANONICAL_BUDGET_INTRODUCED = '0.15.0-beta.1';
const CANONICAL_BUDGET_OPT_IN = '0.19.0-beta.0';
const CANONICAL_BUDGET_DEFAULT = 40960;

function implicitDefaults(absRoot, absPayload) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(absPayload, '.manifest.json'), 'utf8'));
  } catch {
    return []; // no manifest — the payload path is wrong; nothing to infer
  }
  const { fromVersion } = manifest;
  if (typeof fromVersion !== 'string' || fromVersion === 'unknown') return [];
  if (compareVersions(fromVersion, CANONICAL_BUDGET_INTRODUCED) < 0) return [];
  if (compareVersions(fromVersion, CANONICAL_BUDGET_OPT_IN) >= 0) return [];
  let config;
  try {
    config = JSON.parse(readFileSync(join(absRoot, 'workspace.json'), 'utf8'));
  } catch {
    return []; // no workspace.json to preserve a default in
  }
  const ws = config?.workspace && typeof config.workspace === 'object' ? config.workspace : null;
  if (!ws || Object.prototype.hasOwnProperty.call(ws, 'canonicalBudgetBytes')) return [];
  return [{
    key: 'canonicalBudgetBytes',
    value: CANONICAL_BUDGET_DEFAULT,
    reason: `absent meant a ${CANONICAL_BUDGET_DEFAULT}-byte canonical budget before v0.19 and means off since — write the value explicitly or trimming silently stops`,
  }];
}

export function classifyUpdate({ root, payload, baseline: baselineArg = null }) {
  const absRoot = resolve(root);
  const absPayload = resolve(payload ?? join(absRoot, '.workspace-update'));
  if (!existsSync(absPayload)) {
    throw new Error(`No payload found at ${absPayload} — run npx @ulysses-ai/create-workspace --upgrade first`);
  }

  const payloadFiles = [...walkFiles(absPayload)].filter(isClassified);
  const payloadSet = new Set(payloadFiles);
  const { baseline, source } = resolveBaseline({ root: absRoot, payload: absPayload, baseline: baselineArg });
  const mods = readTemplateModifications(absRoot);

  const result = {
    new: [],
    identical: [],
    updated: [],
    differs: [],
    config: [],
    localOnly: [],
    deletedLocally: [],
    activated: [],
    removed: [],
    staleTests: [],
    implicitDefaults: [],
    staleModifications: [],
    legacyKeys: mods.legacyKeys,
    hasBaseline: baseline !== null,
    baselineSource: source,
    baselineReconstructed: baseline !== null && baseline.reconstructed === true,
  };
  if (mods.parseError !== null) result.modificationsError = mods.parseError;
  for (const rel of payloadFiles) {
    // Jointly-owned JSON configs never compare by content — the config
    // list carries a key-level diff for the skill to merge instead.
    if (CONFIG_PATHS.has(rel)) {
      result.config.push(configEntry(absRoot, absPayload, rel));
      continue;
    }
    // A .skip rule whose active counterpart is installed was deliberately
    // activated by this workspace: report it as activated, not new.
    if (rel.startsWith('.claude/rules/') && rel.endsWith('.md.skip')) {
      const active = rel.replace(/\.skip$/, '');
      if (existsSync(join(absRoot, active)) && !existsSync(join(absRoot, rel))) {
        result.activated.push({ skip: rel, active });
        continue;
      }
    }
    const installed = join(absRoot, rel);
    if (!existsSync(installed)) {
      // A file the baseline records and the payload still ships, yet missing
      // from the workspace: deleted locally (or declined at install time) —
      // not new, the template has carried it all along.
      if (baseline && typeof baseline.files[rel] === 'string') {
        result.deletedLocally.push(rel);
      } else {
        result.new.push(rel);
      }
      continue;
    }
    const wsHash = hashBytes(readFileSync(installed));
    const payloadHash = hashBytes(readFileSync(join(absPayload, rel)));
    if (wsHash === payloadHash) {
      result.identical.push(rel);
      continue;
    }
    const baseHash = baseline ? baseline.files[rel] : undefined;
    if (baseHash !== undefined && wsHash === baseHash) {
      // Workspace still holds exactly what the template last shipped here —
      // the difference is the template's own change since then.
      result.updated.push(rel);
    } else if (baseHash !== undefined && payloadHash === baseHash) {
      // The payload is unchanged since the baseline; the workspace's
      // difference is purely local. Informational — nothing to apply.
      result.localOnly.push(rel);
    } else {
      // A local edit on top of a template change (or no baseline entry to
      // compare) — the one case that needs a per-file decision.
      result.differs.push(rel);
    }
  }

  // Removed: installed verbatim-managed files with no payload counterpart.
  const skipSet = new Set(payloadFiles);
  const localFiles = mods.localFiles;
  const installedFiles = [...walkInstalledFiles(absRoot)];
  const gitignored = gitIgnoredPaths(absRoot, installedFiles);
  for (const rel of installedFiles) {
    if (skipSet.has(rel)) continue;
    // A config file the payload dropped stays with the workspace: it holds
    // user content the template never deletes.
    if (CONFIG_PATHS.has(rel)) continue;
    // An active rule whose .skip twin is in the payload is an activated rule,
    // not a removed one.
    if (rel.startsWith('.claude/rules/') && rel.endsWith('.md') && skipSet.has(`${rel}.skip`)) continue;
    if (gitignored.has(rel)) continue;
    // Test files never come from the npm tarball; the payload not carrying one
    // means the template's test suite moved on without this copy.
    if (rel.endsWith('.test.mjs')) {
      result.staleTests.push(rel);
      continue;
    }
    if (isOwnedByWorkspace(rel, localFiles)) continue;
    // No baseline record means the template never shipped the file here —
    // the workspace's own, not a template removal. Marked so the skill
    // offers a workspace.localFiles entry instead of deletion; only a real
    // baseline can prove the negative. An activated optional rule is the
    // exception: the baseline records its .skip twin, which proves the
    // template shipped it, so its removal stays plain (gh:190).
    const templateShipped = typeof baseline?.files[rel] === 'string'
      || (rel.startsWith('.claude/rules/') && rel.endsWith('.md')
        && typeof baseline?.files[`${rel}.skip`] === 'string');
    if (baseline && !templateShipped) {
      result.removed.push({ file: rel, userOwned: true });
    } else {
      result.removed.push(rel);
    }
  }
  linkRemovedHooks(result, absRoot);

  // Registered reasons ride along wherever a local divergence is visible
  // (gh:194): differs/localOnly/deletedLocally entries become { file, reason }
  // for registered paths, and a removed entry — plain, referencedBy, or
  // userOwned — gains the same reason field.
  result.differs = withReasons(result.differs, mods.modifications);
  result.localOnly = withReasons(result.localOnly, mods.modifications);
  result.deletedLocally = withReasons(result.deletedLocally, mods.modifications);
  result.removed = result.removed.map((entry) => {
    const file = typeof entry === 'string' ? entry : entry.file;
    const reason = registeredReason(mods.modifications, file);
    if (reason === undefined) return entry;
    return typeof entry === 'string' ? { file, reason } : { ...entry, reason };
  });

  // Stale registrations: the installed file now equals the payload's copy, so
  // the workspace already holds the template's version and the recorded
  // reason describes nothing. The skill offers to drop them. A path missing
  // on either side never reports — a registered deletion is a live decision
  // (it explains a deletedLocally entry), not a stale one.
  result.staleModifications = Object.entries(mods.modifications)
    .filter(([key]) => {
      const rel = `.claude/${key}`;
      const installed = join(absRoot, rel);
      const inPayload = join(absPayload, rel);
      return existsSync(installed) && existsSync(inPayload)
        && hashBytes(readFileSync(installed)) === hashBytes(readFileSync(inPayload));
    })
    .map(([key, reason]) => ({ file: `.claude/${key}`, reason }));

  result.implicitDefaults = implicitDefaults(absRoot, absPayload);
  return result;
}

/**
 * A removed hook that a workspace-only settings.json entry still registers
 * must not be deleted while its registration stays: mark the removal with
 * `referencedBy` — the config-diff paths (`settings.json hooks.{Event}`) —
 * so the skill removes the file and the settings entry together (gh:190).
 * References are looked for where the config diff shows the workspace
 * holding what the payload doesn't: `arrays[].workspaceOnly` elements and
 * `workspaceOnly` keys (whose value is read from its settings.json).
 */
function linkRemovedHooks(result, absRoot) {
  const settings = result.config.find((c) => c.path === '.claude/settings.json');
  if (!settings || settings.notInstalled || settings.unparseable) return;
  const removedHooks = result.removed.filter(
    (entry) => typeof entry === 'string' && entry.startsWith('.claude/hooks/'),
  );
  if (removedHooks.length === 0) return;
  let wsHooks = null;
  try {
    const wsSettings = JSON.parse(readFileSync(join(absRoot, '.claude', 'settings.json'), 'utf8'));
    if (isPlainObject(wsSettings?.hooks)) wsHooks = wsSettings.hooks;
  } catch {
    return; // the config entry already flagged it unparseable
  }
  for (let i = 0; i < result.removed.length; i++) {
    const rel = result.removed[i];
    if (typeof rel !== 'string' || !rel.startsWith('.claude/hooks/')) continue;
    const referencedBy = [];
    for (const arr of settings.arrays) {
      if (arr.path.startsWith('hooks/') && arr.workspaceOnly.some((el) => JSON.stringify(el).includes(rel))) {
        referencedBy.push(`settings.json ${arr.path.split('/').join('.')}`);
      }
    }
    for (const path of settings.workspaceOnly) {
      if (!path.startsWith('hooks/')) continue;
      const event = wsHooks && wsHooks[path.split('/')[1]];
      if (event !== undefined && JSON.stringify(event).includes(rel)) {
        referencedBy.push(`settings.json ${path.split('/').join('.')}`);
      }
    }
    if (referencedBy.length > 0) {
      result.removed[i] = { file: rel, referencedBy };
    }
  }
}

// ---------- CLAUDE.md merge ----------

/**
 * Split markdown into blocks: the preamble (heading null) plus one block per
 * `## ` heading. Deeper headings belong to their enclosing section, and `## `
 * lines inside fenced code blocks (``` or ~~~) stay content of their section.
 */
function splitBlocks(text) {
  const blocks = [];
  let cur = { heading: null, lines: [] };
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^##\s/.test(line)) {
      blocks.push(cur);
      cur = { heading: line.trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  blocks.push(cur);
  return blocks;
}

/**
 * A heading's merge key. Identical headings match; beyond that, any
 * `## Workspace:` heading matches any other — the intro heading carries the
 * workspace name, which differs the moment a workspace is renamed (or the
 * fallback directory name was used), and treating them as two sections
 * duplicated the template's intro alongside the renamed original.
 */
function headingKey(heading) {
  if (heading !== null && heading.startsWith('## Workspace:')) return '## Workspace:';
  return heading;
}

/**
 * A list entry's merge key: the name of its first backticked `/command`
 * token (`- \`/start-work [handoff|blank]\` — …` → start-work). Two entries
 * with the same name are the same skill, so the template's reworded line
 * replaces the workspace's instead of duplicating it.
 */
function entryKey(line) {
  const m = line.match(/^\s*[-*]\s+`\/([a-z0-9][a-z0-9-]*)[^`]*`/);
  return m ? m[1] : null;
}

function trimTrailingBlanks(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
}

function trimLeadingBlanks(lines) {
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  return lines.slice(start);
}

/**
 * One section's bodies merged: the template's new lines, then the workspace's
 * lines that the template no longer carries (matched by entry name for list
 * entries, by trimmed text otherwise).
 */
function mergeBody(curLines, nxtLines) {
  const nxtKeys = new Set(nxtLines.map(entryKey).filter(Boolean));
  const nxtTrimmed = new Set(nxtLines.map((l) => l.trim()).filter(Boolean));
  const kept = [];
  for (const line of curLines) {
    const key = entryKey(line);
    if (key !== null && nxtKeys.has(key)) continue; // template owns this entry — its line updates ours
    const t = line.trim();
    if (t !== '' && nxtTrimmed.has(t)) continue; // unchanged line, already present
    kept.push(line);
  }
  const body = trimTrailingBlanks(nxtLines);
  return kept.length === 0 ? body : [...body, ...trimLeadingBlanks(trimTrailingBlanks(kept))];
}

function renderBlocks(blocks, eol) {
  const parts = [];
  for (const b of blocks) {
    const body = trimTrailingBlanks(b.lines);
    if (b.heading === null) {
      if (body.length > 0) parts.push(body.join(eol));
    } else {
      parts.push([b.heading, ...body].join(eol));
    }
  }
  return parts.join(eol + eol) + eol;
}

/**
 * Merge an updated template CLAUDE.md (`nextText`, already {{project-name}}-
 * substituted) into the workspace's current one. Template-owned lines take the
 * template's new versions; lines the template doesn't have — the workspace's
 * own skill entries, custom bullets, whole sections — are kept. Sections are
 * matched by heading (`## Workspace:` headings match regardless of name): the
 * result follows the workspace's section order, new template sections are
 * appended at the end, and kept lines land at the end of their section. The
 * output keeps the current file's line endings — CRLF in, CRLF out.
 */
export function mergeClaudeMd(currentText, nextText) {
  const eol = currentText != null && currentText.includes('\r\n') ? '\r\n' : '\n';
  const nxtBlocks = splitBlocks(nextText);
  if (currentText == null || currentText.trim() === '') return renderBlocks(nxtBlocks, eol);
  const nxtByHeading = new Map(nxtBlocks.map((b) => [headingKey(b.heading), b]));
  const used = new Set();
  const out = [];
  for (const cur of splitBlocks(currentText)) {
    const nxt = nxtByHeading.get(headingKey(cur.heading));
    if (nxt) {
      used.add(nxt);
      out.push({ heading: nxt.heading, lines: mergeBody(cur.lines, nxt.lines) });
    } else {
      out.push(cur); // a section the template doesn't have — the workspace's own
    }
  }
  for (const nxt of nxtBlocks) {
    if (!used.has(nxt)) out.push({ heading: nxt.heading, lines: trimTrailingBlanks(nxt.lines) });
  }
  return renderBlocks(out, eol);
}

// ---------- CLI modes ----------

function resolvePayload(args) {
  return resolve(args.payload ?? join(resolve(args.root), '.workspace-update'));
}

function writeBaselineMode(args) {
  const absPayload = resolvePayload(args);
  // The previous baseline decides which declined updates keep their old
  // entry — resolve it exactly as classification does, so the worktree flow
  // (no baseline of its own yet) carries over from the payload's
  // reconstructed one instead of starting from nothing.
  const { baseline: previous } = resolveBaseline({
    root: args.root,
    payload: absPayload,
    baseline: args.baseline,
  });
  const baseline = writeBaseline(args.root, absPayload, { previous });
  process.stdout.write(JSON.stringify({
    written: true,
    path: BASELINE_PATH,
    templateVersion: baseline.templateVersion,
    files: Object.keys(baseline.files).length,
  }, null, 2) + '\n');
}

/**
 * `@{path}` include lines in a CLAUDE.md body whose target file does not
 * exist at the workspace root. Machine-local targets (`local-only-*`
 * basenames) are expected absent on machines that never wrote them — the
 * same exemption the maintenance audit gives those imports — so they never
 * report. The include-line shape mirrors context-footprint's resolveImports:
 * a line whose trimmed content is exactly `@` plus a path.
 */
function missingIncludes(absRoot, text) {
  const missing = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const m = /^@(\S+)$/.exec(rawLine.trim());
    if (!m) continue;
    if (m[1].split('/').pop().startsWith('local-only-')) continue;
    if (!existsSync(resolve(absRoot, m[1]))) missing.push(m[1]);
  }
  return missing;
}

function mergeClaudeMdMode(args) {
  const absRoot = resolve(args.root);
  const absPayload = resolvePayload(args);
  const tmplPath = join(absPayload, 'CLAUDE.md.tmpl');
  if (!existsSync(tmplPath)) {
    throw new Error(`No CLAUDE.md.tmpl in ${absPayload} — nothing to merge`);
  }
  // The workspace name for {{project-name}} substitution: workspace.json is
  // the source of truth; the directory name is the fallback.
  let name = basename(absRoot);
  try {
    const config = JSON.parse(readFileSync(join(absRoot, 'workspace.json'), 'utf8'));
    if (typeof config?.workspace?.name === 'string' && config.workspace.name) name = config.workspace.name;
  } catch { /* no workspace.json — keep the directory name */ }
  const next = readFileSync(tmplPath, 'utf8').replace(/\{\{project-name\}\}/g, name);
  const claudeMdPath = join(absRoot, 'CLAUDE.md');
  const current = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';
  const claudeMd = mergeClaudeMd(current, next);
  // The gained-@include check is deterministic, not something to eyeball in
  // the diff: every include line whose target is absent here is reported so
  // the skill asks (stub or omit) instead of writing it silently (gh:190).
  process.stdout.write(JSON.stringify({
    claudeMd,
    missingIncludes: missingIncludes(absRoot, claudeMd),
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.writeBaseline) {
    writeBaselineMode(args);
  } else if (args.mergeClaudeMd) {
    mergeClaudeMdMode(args);
  } else {
    const result = classifyUpdate({ root: args.root, payload: args.payload, baseline: args.baseline });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`classify-update: ${err.message}\n`);
    process.exit(1);
  }
}
