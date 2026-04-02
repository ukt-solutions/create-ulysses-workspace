import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import prompts from 'prompts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', 'template');

export async function migrate(targetDir) {
  console.log(`\n  Migrating workspace at ${targetDir}\n`);

  const onCancel = () => false;

  // Detect existing structure
  const has = {
    claudeMd: existsSync(join(targetDir, 'CLAUDE.md')),
    workspaceJson: existsSync(join(targetDir, 'workspace.json')),
    claudeDir: existsSync(join(targetDir, '.claude')),
    rules: existsSync(join(targetDir, '.claude', 'rules')),
    skills: existsSync(join(targetDir, '.claude', 'skills')),
    agents: existsSync(join(targetDir, '.claude', 'agents')),
    hooks: existsSync(join(targetDir, '.claude', 'hooks')),
    sharedContext: existsSync(join(targetDir, 'shared-context')),
    repos: existsSync(join(targetDir, 'repos')),
    scratchpad: existsSync(join(targetDir, '.claude-scratchpad')),
    gitignore: existsSync(join(targetDir, '.gitignore')),
  };

  const existing = Object.entries(has).filter(([, v]) => v).map(([k]) => k);
  const missing = Object.entries(has).filter(([, v]) => !v).map(([k]) => k);

  console.log(`  Found: ${existing.join(', ') || 'nothing'}`);
  console.log(`  Missing: ${missing.join(', ') || 'nothing — fully set up'}\n`);

  // Create missing directories
  const dirs = [
    { path: '.claude', key: 'claudeDir' },
    { path: '.claude/rules', key: 'rules' },
    { path: '.claude/skills', key: 'skills' },
    { path: '.claude/agents', key: 'agents' },
    { path: '.claude/hooks', key: 'hooks' },
    { path: 'shared-context', key: 'sharedContext' },
    { path: 'shared-context/locked', key: null },
    { path: 'repos', key: 'repos' },
    { path: '.claude-scratchpad', key: 'scratchpad' },
  ];

  for (const dir of dirs) {
    const fullPath = join(targetDir, dir.path);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      console.log(`  Created ${dir.path}/`);
    }
  }

  // Copy template components selectively
  const components = [
    { name: 'hooks', src: '.claude/hooks', check: has.hooks },
    { name: 'skills', src: '.claude/skills', check: has.skills },
    { name: 'agents', src: '.claude/agents', check: has.agents },
    { name: 'rules', src: '.claude/rules', check: has.rules },
  ];

  for (const comp of components) {
    if (!comp.check) {
      const { install } = await prompts({
        type: 'confirm',
        name: 'install',
        message: `Add ${comp.name}?`,
        initial: true,
      }, { onCancel });
      if (install === undefined) return;

      if (install) {
        cpSync(join(TEMPLATE_DIR, comp.src), join(targetDir, comp.src), { recursive: true });
        console.log(`  Installed ${comp.name}`);
      }
    } else {
      const { update } = await prompts({
        type: 'confirm',
        name: 'update',
        message: `${comp.name} already exists. Add missing files from template?`,
        initial: false,
      }, { onCancel });
      if (update === undefined) return;

      if (update) {
        // Only copy files that don't exist locally
        const templateFiles = readdirSync(join(TEMPLATE_DIR, comp.src), { recursive: true });
        let added = 0;
        for (const file of templateFiles) {
          const localPath = join(targetDir, comp.src, file);
          if (!existsSync(localPath)) {
            const templatePath = join(TEMPLATE_DIR, comp.src, file);
            cpSync(templatePath, localPath, { recursive: true });
            added++;
          }
        }
        if (added > 0) console.log(`  Added ${added} new files to ${comp.name}`);
      }
    }
  }

  // Settings
  if (!existsSync(join(targetDir, '.claude', 'settings.json'))) {
    cpSync(
      join(TEMPLATE_DIR, '.claude', 'settings.json'),
      join(targetDir, '.claude', 'settings.json')
    );
    console.log('  Created .claude/settings.json');
  }

  // workspace.json
  if (!has.workspaceJson) {
    const name = targetDir.split('/').pop();
    const template = readFileSync(join(TEMPLATE_DIR, 'workspace.json.tmpl'), 'utf-8');
    const content = template.replace(/\{\{project-name\}\}/g, name);
    writeFileSync(join(targetDir, 'workspace.json'), content);
    console.log('  Created workspace.json');
  }

  // CLAUDE.md
  if (!has.claudeMd) {
    const name = targetDir.split('/').pop();
    const template = readFileSync(join(TEMPLATE_DIR, 'CLAUDE.md.tmpl'), 'utf-8');
    const content = template.replace(/\{\{project-name\}\}/g, name);
    writeFileSync(join(targetDir, 'CLAUDE.md'), content);
    console.log('  Created CLAUDE.md');
  }

  // .gitignore
  if (!has.gitignore) {
    cpSync(join(TEMPLATE_DIR, '_gitignore'), join(targetDir, '.gitignore'));
    console.log('  Created .gitignore');
  }

  // User identity
  const settingsLocalPath = join(targetDir, '.claude', 'settings.local.json');
  if (!existsSync(settingsLocalPath)) {
    const defaultUser = process.env.USER || process.env.USERNAME || 'user';
    const { userName } = await prompts({
      type: 'text',
      name: 'userName',
      message: 'Your name (for context scoping):',
      initial: defaultUser,
    }, { onCancel });
    if (!userName) return;

    writeFileSync(settingsLocalPath, JSON.stringify({ workspace: { user: userName } }, null, 2) + '\n');
    console.log('  Created settings.local.json');
  }

  // .keep files
  for (const keepDir of ['shared-context/locked', 'repos', '.claude-scratchpad']) {
    const keepPath = join(targetDir, keepDir, '.keep');
    if (!existsSync(keepPath)) {
      writeFileSync(keepPath, '');
    }
  }

  console.log('\n  Migration complete.\n');
}
