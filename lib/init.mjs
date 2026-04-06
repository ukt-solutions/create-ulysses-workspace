// lib/init.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { stagePayload, getTemplateVersion } from './payload.mjs';

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function mergeBootstrapHook(settingsPath) {
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {}
  }

  if (!settings.hooks) settings.hooks = {};

  const hookEntry = {
    type: 'command',
    command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/workspace-update-check.mjs',
    timeout: 5000,
    statusMessage: 'Checking for workspace updates...',
  };

  // Add to SessionStart
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  const ssHooks = settings.hooks.SessionStart[0]?.hooks || [];
  if (!ssHooks.some(h => h.command?.includes('workspace-update-check'))) {
    if (settings.hooks.SessionStart.length === 0) {
      settings.hooks.SessionStart.push({ hooks: [hookEntry] });
    } else {
      if (!settings.hooks.SessionStart[0].hooks) settings.hooks.SessionStart[0].hooks = [];
      settings.hooks.SessionStart[0].hooks.unshift(hookEntry);
    }
  }

  // Add to PreToolUse
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
  const ptuHooks = settings.hooks.PreToolUse[0]?.hooks || [];
  if (!ptuHooks.some(h => h.command?.includes('workspace-update-check'))) {
    if (settings.hooks.PreToolUse.length === 0) {
      settings.hooks.PreToolUse.push({ hooks: [{ ...hookEntry, statusMessage: undefined }] });
    } else {
      if (!settings.hooks.PreToolUse[0].hooks) settings.hooks.PreToolUse[0].hooks = [];
      settings.hooks.PreToolUse[0].hooks.unshift({ ...hookEntry, statusMessage: undefined });
    }
  }

  ensureDir(dirname(settingsPath));
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

export async function initWorkspace(targetDir) {
  const name = targetDir.split('/').pop();
  const workspaceJsonPath = join(targetDir, 'workspace.json');
  const settingsPath = join(targetDir, '.claude', 'settings.json');
  const claudeMdPath = join(targetDir, 'CLAUDE.md');
  const gitignorePath = join(targetDir, '.gitignore');
  const hookDir = join(targetDir, '.claude', 'hooks');
  const hookScript = join(hookDir, 'workspace-update-check.mjs');

  console.log(`\n  create-claude-workspace --init`);
  console.log(`  Target: ${targetDir}\n`);

  // Stage payload
  const { toVersion } = stagePayload(targetDir, { action: 'init' });
  console.log(`  Staged template payload (v${toVersion})`);

  // Create bare workspace.json if missing
  if (!existsSync(workspaceJsonPath)) {
    writeFileSync(workspaceJsonPath, JSON.stringify({
      workspace: {
        name,
        initialized: false,
        templateVersion: null,
      },
      repos: {},
    }, null, 2) + '\n');
    console.log('  Created workspace.json (initialized: false)');
  }

  // Wire bootstrap hook into settings.json
  mergeBootstrapHook(settingsPath);
  console.log('  Wired bootstrap hook into .claude/settings.json');

  // Write the bootstrap hook script itself
  ensureDir(hookDir);
  if (!existsSync(hookScript)) {
    // Copy from payload
    const payloadHook = join(targetDir, '.workspace-update', '.claude', 'hooks', 'workspace-update-check.mjs');
    const payloadUtils = join(targetDir, '.workspace-update', '.claude', 'hooks', '_utils.mjs');
    if (existsSync(payloadHook)) cpSync(payloadHook, hookScript);
    // Also copy _utils.mjs since the hook depends on it
    const utilsDest = join(hookDir, '_utils.mjs');
    if (existsSync(payloadUtils) && !existsSync(utilsDest)) cpSync(payloadUtils, utilsDest);
    console.log('  Installed bootstrap hook script');
  }

  // Replace CLAUDE.md with bootstrap version (back up existing)
  const imports = [
    '@.workspace-update/.claude/rules/coherent-revisions.md',
    '@.workspace-update/.claude/rules/honest-pushback.md',
  ];
  const importBlock = imports.join('\n');
  const bootstrapContent = `## Workspace: ${name}\n\nThis workspace is being initialized. Follow the hook instructions.\n\n${importBlock}\n`;

  if (existsSync(claudeMdPath)) {
    const backupPath = claudeMdPath + '.bak';
    cpSync(claudeMdPath, backupPath);
    console.log('  Backed up existing CLAUDE.md to CLAUDE.md.bak');
  }
  writeFileSync(claudeMdPath, bootstrapContent);
  console.log('  Created bootstrap CLAUDE.md (old content backed up)');

  // Ensure .gitignore has .workspace-update/
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.workspace-update/')) {
      writeFileSync(gitignorePath, content.trimEnd() + '\n\n# Workspace update payload (transient)\n.workspace-update/\n');
      console.log('  Added .workspace-update/ to .gitignore');
    }
  } else {
    writeFileSync(gitignorePath, '# Workspace update payload (transient)\n.workspace-update/\n');
    console.log('  Created .gitignore');
  }

  console.log(`
  Template payload staged (v${toVersion}). Open Claude Code and
  say 'Hi', the workspace will initialize automatically.
`);
}
