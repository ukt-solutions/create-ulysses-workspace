// lib/init.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { stagePayload, getTemplateVersion } from './payload.mjs';

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function initWorkspace(targetDir) {
  const name = targetDir.split('/').pop();
  const workspaceJsonPath = join(targetDir, 'workspace.json');
  const claudeMdPath = join(targetDir, 'CLAUDE.md');
  const gitignorePath = join(targetDir, '.gitignore');

  console.log(`\n  create-claude-workspace --init`);
  console.log(`  Target: ${targetDir}\n`);

  // Stage payload
  const { toVersion, payloadDir } = stagePayload(targetDir, { action: 'init' });
  console.log(`  Staged template payload (v${toVersion})`);

  // Install only the bootstrap skills needed to complete initialization
  const bootstrapSkills = ['workspace-init', 'workspace-update'];
  const payloadSkills = join(payloadDir, '.claude', 'skills');
  const targetSkills = join(targetDir, '.claude', 'skills');
  for (const skill of bootstrapSkills) {
    const src = join(payloadSkills, skill);
    const dest = join(targetSkills, skill);
    if (existsSync(src) && !existsSync(dest)) {
      ensureDir(dest);
      cpSync(src, dest, { recursive: true });
    }
  }
  console.log('  Installed bootstrap skills (workspace-init, workspace-update)');

  // Install hooks and scripts (needed for workspace to function)
  const payloadHooks = join(payloadDir, '.claude', 'hooks');
  const targetHooks = join(targetDir, '.claude', 'hooks');
  if (existsSync(payloadHooks)) {
    ensureDir(targetHooks);
    for (const entry of readdirSync(payloadHooks)) {
      const src = join(payloadHooks, entry);
      const dest = join(targetHooks, entry);
      if (!existsSync(dest) && !statSync(src).isDirectory()) {
        cpSync(src, dest);
      }
    }
    console.log('  Installed hooks');
  }

  const payloadScripts = join(payloadDir, '.claude', 'scripts');
  const targetScripts = join(targetDir, '.claude', 'scripts');
  if (existsSync(payloadScripts)) {
    ensureDir(targetScripts);
    for (const entry of readdirSync(payloadScripts)) {
      const src = join(payloadScripts, entry);
      const dest = join(targetScripts, entry);
      if (!existsSync(dest) && !statSync(src).isDirectory()) {
        cpSync(src, dest);
      }
    }
    console.log('  Installed scripts');
  }

  // Create shared-context structure from payload
  const payloadContext = join(payloadDir, 'shared-context');
  const targetContext = join(targetDir, 'shared-context');
  if (existsSync(payloadContext) && !existsSync(targetContext)) {
    cpSync(payloadContext, targetContext, { recursive: true });
    console.log('  Created shared-context/');
  }

  // Create repos/ directory
  const reposDir = join(targetDir, 'repos');
  if (!existsSync(reposDir)) {
    mkdirSync(reposDir, { recursive: true });
    console.log('  Created repos/');
  }

  // Create .claude-scratchpad/ directory
  const scratchpadDir = join(targetDir, '.claude-scratchpad');
  if (!existsSync(scratchpadDir)) {
    mkdirSync(scratchpadDir, { recursive: true });
    console.log('  Created .claude-scratchpad/');
  }

  // Create workspace.json if missing
  if (!existsSync(workspaceJsonPath)) {
    writeFileSync(workspaceJsonPath, JSON.stringify({
      workspace: {
        name,
        templateVersion: toVersion,
        scratchpadDir: '.claude-scratchpad',
        worktreeSuffix: '___wt-',
        sharedContextDir: 'shared-context',
        releaseNotesDir: 'release-notes',
        subagentContextMaxBytes: 10240,
        greeting: `Welcome back to ${name}.`,
      },
      repos: {},
    }, null, 2) + '\n');
    console.log('  Created workspace.json');
  }

  // Replace CLAUDE.md with template version (back up existing)
  const tmplPath = join(payloadDir, 'CLAUDE.md.tmpl');
  let claudeContent;
  if (existsSync(tmplPath)) {
    claudeContent = readFileSync(tmplPath, 'utf-8').replace(/\{\{project-name\}\}/g, name);
  } else {
    claudeContent = `## Workspace: ${name}\n\nThis is a claude-workspace. All conventions are defined in .claude/rules/.\n`;
  }

  if (existsSync(claudeMdPath)) {
    cpSync(claudeMdPath, claudeMdPath + '.bak');
    console.log('  Backed up existing CLAUDE.md to CLAUDE.md.bak');
  }
  writeFileSync(claudeMdPath, claudeContent);
  console.log('  Created CLAUDE.md');

  // Set up .gitignore
  const payloadGitignore = join(payloadDir, '_gitignore');
  if (existsSync(payloadGitignore)) {
    if (existsSync(gitignorePath)) {
      // Merge: append any missing lines from template
      const existing = readFileSync(gitignorePath, 'utf-8');
      const template = readFileSync(payloadGitignore, 'utf-8');
      const existingLines = new Set(existing.split('\n').map(l => l.trim()));
      const newLines = template.split('\n').filter(l => l.trim() && !existingLines.has(l.trim()));
      if (newLines.length > 0) {
        writeFileSync(gitignorePath, existing.trimEnd() + '\n\n# From workspace template\n' + newLines.join('\n') + '\n');
        console.log('  Merged template entries into .gitignore');
      }
    } else {
      cpSync(payloadGitignore, gitignorePath);
      console.log('  Created .gitignore');
    }
  }

  console.log(`
  Workspace initialized (v${toVersion}).

  Next steps:
    cd ${targetDir}
    claude
    /workspace-init
`);
}
