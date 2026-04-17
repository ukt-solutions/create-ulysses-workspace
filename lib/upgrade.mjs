// lib/upgrade.mjs
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { stagePayload } from './payload.mjs';

export async function upgradeWorkspace(targetDir) {
  const workspaceJsonPath = join(targetDir, 'workspace.json');

  console.log(`\n  @ulysses/create-workspace --upgrade`);
  console.log(`  Target: ${targetDir}\n`);

  // Verify workspace exists and is initialized
  if (!existsSync(workspaceJsonPath)) {
    console.error(`  Error: No workspace.json found at ${targetDir}.`);
    console.error(`  Run with --init instead:\n    npx @ulysses/create-workspace --init ${targetDir}\n`);
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(workspaceJsonPath, 'utf-8'));
  const initialized = config.workspace?.initialized || config.workspace?.templateVersion;
  if (!initialized) {
    console.error(`  Error: Workspace not initialized.`);
    console.error(`  Run with --init instead:\n    npx @ulysses/create-workspace --init ${targetDir}\n`);
    process.exit(1);
  }

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
