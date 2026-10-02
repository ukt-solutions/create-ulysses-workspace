// lib/upgrade.mjs
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, mkdtempSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { stagePayload, extractTarballEntries, fetchPackageTarball } from './payload.mjs';
import {
  buildBaseline, BASELINE_PATH, LIVE_PAIRS, INERT_PAIRS,
} from '../template/_claude/scripts/template-baseline.mjs';

// .workspace-update/ is a transient staging area and is gitignored from
// v0.19.0 on — but workspaces upgraded from older templates may still track
// it from a previous run. A tracked payload gets committed, shared with
// teammates, and confuses /workspace-update, so surface it loudly.
function warnIfPayloadTracked(targetDir) {
  const r = spawnSync('git', ['ls-files', '.workspace-update'], {
    cwd: targetDir,
    encoding: 'utf-8',
  });
  // Not a git repo (or git unavailable) — nothing can be tracked.
  if (r.status !== 0) return;
  const tracked = (r.stdout || '').split('\n').filter(Boolean);
  if (tracked.length === 0) return;
  console.error(`  Warning: .workspace-update/ is tracked by git (${tracked.length} file(s)) — it is a transient staging area.`);
  console.error(`  Untrack it and commit:\n    git rm -r --cached .workspace-update\n    git commit -m "chore: untrack .workspace-update payload"\n`);
}

// The workspace runs its INSTALLED /workspace-update after the CLI exits,
// and an older installed copy predates the classifier/baseline/audit flow
// the new payload ships — the assistant would improvise the update. So
// --upgrade bootstraps the payload's copy into .claude/skills/ before
// finishing, the same way --init installs bootstrap skills. The directory
// is REPLACED, not merged: stale files inside the old skill must not
// survive next to the new flow.
function installWorkspaceUpdateSkill(targetDir, payloadDir) {
  const src = join(payloadDir, '.claude', 'skills', 'workspace-update');
  if (!existsSync(src)) return false;
  const dest = join(targetDir, '.claude', 'skills', 'workspace-update');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  return true;
}

// A workspace upgraded from a pre-baseline template version has no
// .claude/.template-baseline.json, so its first /workspace-update reports
// every template change as a local edit — dozens of per-file questions
// with a handful of real edits among them. The template tree of the
// INSTALLED version still exists in exactly one place: its published npm
// tarball. Fetch it, hash what that version shipped (the same
// normalisation template-baseline.mjs applies everywhere), and write a
// baseline for it marked "reconstructed": true, so the update classifies
// three ways from the start. Any failure — unknown version, offline,
// unparsable tarball — warns and falls back to the ask-per-file behaviour;
// the upgrade itself never fails because of this.
async function reconstructBaseline(targetDir, fromVersion, { fetchTarball = fetchPackageTarball } = {}) {
  const fallbackNote = '  The first /workspace-update will ask about every changed file individually.';
  if (typeof fromVersion !== 'string' || fromVersion === 'unknown' || fromVersion === '') {
    console.error('  Warning: workspace.json records no templateVersion — cannot reconstruct a template baseline.');
    console.error(fallbackNote);
    return false;
  }
  let tarball = null;
  try {
    tarball = await fetchTarball(fromVersion);
  } catch { /* a failing fetch is the same as no fetch */ }
  if (tarball === null) {
    console.error(`  Warning: could not fetch the v${fromVersion} package tarball from npm — no template baseline written.`);
    console.error(fallbackNote);
    return false;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'create-workspace-baseline-'));
  try {
    // npm tarballs root every file under package/; the template itself
    // ships under both layouts across versions: _claude/ and _mcp.json
    // (v0.19.0 on, same as this package) and the older live-named .claude/
    // and .mcp.json. buildBaseline maps either onto the installed names
    // through its pairs.
    const extracted = join(tmp, 'template');
    let baseline = null;
    try {
      extractTarballEntries(tarball, extracted, { prefix: 'package/template/' });
      const pairs = existsSync(join(extracted, '_claude')) ? INERT_PAIRS : LIVE_PAIRS;
      baseline = buildBaseline(extracted, { pairs, version: fromVersion });
    } catch { /* unreadable tarball or unhashable tree — the fallback below */ }
    if (baseline === null || Object.keys(baseline.files).length === 0) {
      console.error(`  Warning: the v${fromVersion} package tarball carries no readable template files — no template baseline written.`);
      console.error(fallbackNote);
      return false;
    }
    baseline.reconstructed = true;
    const dest = join(targetDir, BASELINE_PATH);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`  Reconstructed template baseline for v${fromVersion} from the npm tarball (${Object.keys(baseline.files).length} files)`);
    return true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function upgradeWorkspace(targetDir, opts = {}) {
  const workspaceJsonPath = join(targetDir, 'workspace.json');

  console.log(`\n  @ulysses-ai/create-workspace --upgrade`);
  console.log(`  Target: ${targetDir}\n`);

  // Verify workspace exists and is initialized
  if (!existsSync(workspaceJsonPath)) {
    console.error(`  Error: No workspace.json found at ${targetDir}.`);
    console.error(`  Run with --init instead:\n    npx @ulysses-ai/create-workspace --init ${targetDir}\n`);
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(workspaceJsonPath, 'utf-8'));
  const initialized = config.workspace?.initialized || config.workspace?.templateVersion;
  if (!initialized) {
    console.error(`  Error: Workspace not initialized.`);
    console.error(`  Run with --init instead:\n    npx @ulysses-ai/create-workspace --init ${targetDir}\n`);
    process.exit(1);
  }

  warnIfPayloadTracked(targetDir);

  const fromVersion = config.workspace?.templateVersion || 'unknown';

  // A workspace older than the baseline's introduction has no baseline —
  // reconstruct one for the installed version before staging, so the
  // update can tell template changes from local edits (gh:186).
  if (!existsSync(join(targetDir, BASELINE_PATH))) {
    await reconstructBaseline(targetDir, fromVersion, opts);
  }

  // Stage payload
  const { payloadDir, toVersion } = stagePayload(targetDir, { action: 'upgrade', fromVersion });

  // Bootstrap the current /workspace-update skill — the workspace runs its
  // installed copy next, and the old one does not know this payload's flow.
  if (installWorkspaceUpdateSkill(targetDir, payloadDir)) {
    console.log('  Installed the current workspace-update skill (.claude/skills/workspace-update/)');
  }

  if (fromVersion === toVersion) {
    console.log(`  Workspace is already on template v${toVersion}.`);
    console.log(`  Payload staged anyway — run /workspace-update to verify integrity.`);
  } else {
    console.log(`  Staged template payload (v${fromVersion} → v${toVersion})`);
  }

  console.log(`  Template payload staged. The workspace will update on your
  next Claude Code prompt.
`);
}
