// lib/upgrade.mjs
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { stagePayload } from './payload.mjs';

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

export async function upgradeWorkspace(targetDir) {
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

  // Stage payload
  const { toVersion } = stagePayload(targetDir, { action: 'upgrade', fromVersion });

  if (fromVersion === toVersion) {
    console.log(`  Workspace is already on template v${toVersion}.`);
    console.log(`  Payload staged anyway — run /workspace-update to verify integrity.\n`);
  } else {
    console.log(`  Staged template payload (v${fromVersion} → v${toVersion})`);
  }

  console.log(`  Template payload staged. The workspace will update on your
  next Claude Code prompt.
`);
}
