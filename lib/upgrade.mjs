// lib/upgrade.mjs
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, mkdtempSync, renameSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { stagePayload, extractTarballEntries, fetchPackageTarball } from './payload.mjs';
import {
  buildBaseline, RECONSTRUCTED_BASELINE_NAME, LIVE_PAIRS, INERT_PAIRS,
  readBaseline, readBaselineFile, hashBytes,
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
// survive next to the new flow. Two safety properties (gh:186):
//   - a locally customised SKILL.md (matching neither the payload's copy
//     nor the hash of what the installed template version shipped) is
//     backed up as SKILL.md.local-backup before the swap, and
//   - the new tree is copied to a sibling staging directory and swapped in
//     only once the copy succeeded — a copy that fails partway leaves the
//     old skill in place, never an empty directory.
function installWorkspaceUpdateSkill(targetDir, payloadDir, { copySkill = cpSync } = {}) {
  const src = join(payloadDir, '.claude', 'skills', 'workspace-update');
  if (!existsSync(src)) return false;
  const skillsDir = join(targetDir, '.claude', 'skills');
  const dest = join(skillsDir, 'workspace-update');

  let backup = null;
  const installedSkillMd = join(dest, 'SKILL.md');
  if (existsSync(installedSkillMd)) {
    const installedHash = hashBytes(readFileSync(installedSkillMd));
    const payloadHash = hashBytes(readFileSync(join(src, 'SKILL.md')));
    const oldBaseline = readBaselineFile(join(payloadDir, RECONSTRUCTED_BASELINE_NAME));
    const shippedHash = oldBaseline ? oldBaseline.files['.claude/skills/workspace-update/SKILL.md'] : undefined;
    if (installedHash !== payloadHash && shippedHash !== installedHash) {
      backup = readFileSync(installedSkillMd);
    }
  }

  const incoming = join(skillsDir, '.workspace-update.incoming');
  mkdirSync(skillsDir, { recursive: true });
  rmSync(incoming, { recursive: true, force: true });
  try {
    copySkill(src, incoming, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    try {
      renameSync(incoming, dest);
    } catch {
      // rename across filesystems or onto a slow handle — a plain copy of
      // the already-verified staging tree still completes the install.
      copySkill(incoming, dest, { recursive: true });
      rmSync(incoming, { recursive: true, force: true });
    }
  } catch (err) {
    rmSync(incoming, { recursive: true, force: true });
    console.error(`  Warning: could not install the current workspace-update skill (${err.message}) — the installed copy stays.`);
    return false;
  }
  if (backup !== null) {
    writeFileSync(join(dest, 'SKILL.md.local-backup'), backup);
    console.log('  Existing workspace-update skill was modified locally — backed up to .claude/skills/workspace-update/SKILL.md.local-backup');
  }
  return true;
}

// A workspace upgraded from a pre-baseline template version has no
// .claude/.template-baseline.json, so its first /workspace-update reports
// every template change as a local edit — dozens of per-file questions
// with a handful of real edits among them. The template tree of the
// INSTALLED version still exists in exactly one place: its published npm
// tarball. Fetch it, hash what that version shipped (the same
// normalisation template-baseline.mjs applies everywhere), and stage a
// baseline for it marked "reconstructed": true INSIDE THE PAYLOAD, not the
// launcher: with a remote, /workspace-update classifies inside a task
// worktree that can only see what travels with the payload, and an
// untracked launcher baseline would dirty the launcher against the incoming
// PR. classify-update.mjs falls back to the staged file automatically.
// Any failure — unknown version, offline, unparsable tarball — warns and
// falls back to the ask-per-file behaviour; the upgrade itself never fails.
async function reconstructBaseline(payloadDir, fromVersion, { fetchTarball = fetchPackageTarball } = {}) {
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
    writeFileSync(
      join(payloadDir, RECONSTRUCTED_BASELINE_NAME),
      JSON.stringify(baseline, null, 2) + '\n',
    );
    console.log(`  Reconstructed template baseline for v${fromVersion} from the npm tarball (${Object.keys(baseline.files).length} files) — staged in the payload as ${RECONSTRUCTED_BASELINE_NAME}`);
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

  // Stage the payload first: a reconstructed baseline is staged INSIDE it.
  const { payloadDir, toVersion } = stagePayload(targetDir, { action: 'upgrade', fromVersion });

  // A workspace older than the baseline's introduction has no baseline —
  // and a corrupt one is as good as none (readBaseline parses it). In
  // either case reconstruct one for the installed version into the payload,
  // so the update can tell template changes from local edits (gh:186).
  if (readBaseline(targetDir) !== null) {
    console.log('  Template baseline already present — leaving it in place.');
  } else {
    await reconstructBaseline(payloadDir, fromVersion, opts);
  }

  // Bootstrap the current /workspace-update skill — the workspace runs its
  // installed copy next, and the old one does not know this payload's flow.
  if (installWorkspaceUpdateSkill(targetDir, payloadDir, opts)) {
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
