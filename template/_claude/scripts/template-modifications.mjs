#!/usr/bin/env node
// Reader for .claude/template-modifications.json — the workspace's registry
// of how it deliberately diverges from the template (gh:194).
//
// Shape (paths relative to .claude/; a leading ".claude/" on a key or entry
// is tolerated and stripped on read):
//   {
//     "localFiles": ["skills/my-skill/**", "rules/my-rule.md"],
//     "modifications": { "rules/core.md": "kept our stricter lint gate" }
//   }
//
// localFiles — files this workspace owns outright: never offered by
//   /workspace-update, neither as an update nor as a removal. Semantics are
//   unchanged from the workspace.json → workspace.localFiles array the field
//   migrates from.
// modifications — deliberate edits to files the template still owns: they
//   keep updating (three-way merge when both sides changed), and the
//   recorded reason is shown whenever the file comes up for a decision, so
//   "why does this file differ?" survives the person who made the edit.
//
// The file is workspace-owned: the template never ships or overwrites it.
// An upgrade payload carries no copy, and classify-update treats the path
// like the baseline — never as a template removal.
//
// Legacy fallback, for one release: workspaces that predate the file keep
// their data in workspace.json — `workspace.localFiles` (the old array) and
// `workspace.templateModifications` (an improvised path→reason map some
// workspaces adopted before the file existed). Both are read here so
// nothing breaks before /workspace-update migrates them; `legacyKeys` names
// the ones still present so the skill and the maintenance audit can offer
// the migration. Where the file and a legacy key both carry data, the file
// wins per modification path and the localFiles arrays union — a
// half-finished migration never loses an exclusion or hides a reason.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const TEMPLATE_MODIFICATIONS_PATH = '.claude/template-modifications.json';

// workspace.json keys the file replaces. `localFiles` is the documented
// pre-gh:194 array; `templateModifications` is the improvised map.
export const LEGACY_KEYS = ['localFiles', 'templateModifications'];

// '.claude/rules/core.md' → 'rules/core.md'; repeated prefixes collapse.
function normalizeRel(value) {
  return value.replace(/^(\.claude\/)+/, '');
}

function normalizeLocalFiles(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => typeof e === 'string' && e.length > 0)
    .map(normalizeRel);
}

function normalizeModifications(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return {};
  const out = {};
  for (const [key, reason] of Object.entries(map)) {
    if (key.length === 0 || typeof reason !== 'string' || reason.length === 0) continue;
    out[normalizeRel(key)] = reason;
  }
  return out;
}

/**
 * Read the workspace's template-modification registry: the file first, the
 * legacy workspace.json keys filling whatever it doesn't carry. Returns:
 *   localFiles    — normalized .claude/-relative paths/globs, unioned
 *   modifications — { '.claude/-relative path': reason }, the file winning
 *                   per path, keys sorted for deterministic output
 *   legacyKeys    — LEGACY_KEYS still present in workspace.json (the
 *                   migration is unfinished; /workspace-update offers it)
 *   parseError    — message when the file exists but doesn't parse. Its
 *                   content is then treated as absent — never guessed at —
 *                   so the legacy keys alone apply and the callers surface
 *                   the error.
 */
export function readTemplateModifications(root) {
  const absRoot = resolve(root);
  let ws = null;
  try {
    const config = JSON.parse(readFileSync(join(absRoot, 'workspace.json'), 'utf8'));
    if (config?.workspace && typeof config.workspace === 'object') ws = config.workspace;
  } catch { /* no workspace.json (or unparseable — the audit reports that) */ }

  const legacyKeys = ws !== null
    ? LEGACY_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(ws, k))
    : [];
  const localFiles = normalizeLocalFiles(ws?.localFiles);
  let modifications = normalizeModifications(ws?.templateModifications);

  let parseError = null;
  const filePath = join(absRoot, TEMPLATE_MODIFICATIONS_PATH);
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      for (const entry of normalizeLocalFiles(parsed.localFiles)) {
        if (!localFiles.includes(entry)) localFiles.push(entry);
      }
      modifications = { ...modifications, ...normalizeModifications(parsed.modifications) };
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  const sorted = Object.keys(modifications).sort();
  return {
    localFiles,
    modifications: Object.fromEntries(sorted.map((k) => [k, modifications[k]])),
    legacyKeys,
    parseError,
  };
}
