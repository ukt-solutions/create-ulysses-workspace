// lib/init.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { stagePayload } from './payload.mjs';

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export async function initWorkspace(targetDir) {
  const name = basename(targetDir);
  const workspaceJsonPath = join(targetDir, 'workspace.json');
  const claudeMdPath = join(targetDir, 'CLAUDE.md');
  const gitignorePath = join(targetDir, '.gitignore');

  console.log(`\n  @ulysses-ai/create-workspace --init`);
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

  // Install hooks, scripts, and lib (needed for workspace to function)
  for (const dir of ['hooks', 'scripts', 'lib']) {
    const src = join(payloadDir, '.claude', dir);
    const dest = join(targetDir, '.claude', dir);
    if (!existsSync(src)) continue;
    ensureDir(dest);
    for (const entry of readdirSync(src)) {
      const srcEntry = join(src, entry);
      const destEntry = join(dest, entry);
      if (!existsSync(destEntry) && !statSync(srcEntry).isDirectory()) {
        cpSync(srcEntry, destEntry);
      }
    }
    console.log(`  Installed ${dir}`);
  }

  // Create shared-context structure. We always want shared-context/ and
  // shared-context/locked/ to exist after init, even if the payload ships
  // no files for them yet — locked/ is referenced by CLAUDE.md.tmpl via
  // the @shared-context/locked/ import directive.
  const payloadContext = join(payloadDir, 'shared-context');
  const targetContext = join(targetDir, 'shared-context');
  if (existsSync(payloadContext) && !existsSync(targetContext)) {
    cpSync(payloadContext, targetContext, { recursive: true });
    console.log('  Created shared-context/');
  }
  ensureDir(join(targetDir, 'shared-context', 'locked'));

  // Everything else (repos/, work-sessions/, workspace-scratchpad/) is
  // lazy-created by scripts and hooks when they first need to write.
  // We intentionally do NOT pre-create these dirs — they get made on demand.

  // Create workspace.json if missing
  if (!existsSync(workspaceJsonPath)) {
    writeFileSync(workspaceJsonPath, JSON.stringify({
      workspace: {
        name,
        templateVersion: toVersion,
        scratchpadDir: 'workspace-scratchpad',
        workSessionsDir: 'work-sessions',
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
