import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import prompts from 'prompts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', 'template');

function detectRepos(targetDir) {
  const reposDir = join(targetDir, 'repos');
  if (!existsSync(reposDir)) return [];
  const repos = [];
  for (const entry of readdirSync(reposDir)) {
    const fullPath = join(reposDir, entry);
    if (!statSync(fullPath).isDirectory()) continue;
    if (entry === '.keep') continue;
    if (entry.includes('___wt-')) continue;
    if (existsSync(join(fullPath, '.git'))) {
      let remote = '';
      try { remote = execSync(`git -C "${fullPath}" remote get-url origin`, { encoding: 'utf-8' }).trim(); } catch {}
      let branch = 'main';
      try { branch = execSync(`git -C "${fullPath}" branch --show-current`, { encoding: 'utf-8' }).trim(); } catch {}
      repos.push({ name: entry, remote, branch });
    }
  }
  return repos;
}

function walkDir(dir, base = '') {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = join(base, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkDir(full, rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

export async function migrate(targetDir, { update = false } = {}) {
  const onCancel = () => false;

  console.log(`\n  create-claude-workspace --migrate${update ? ' --update' : ''}`);
  console.log(`  Target: ${targetDir}\n`);

  // --- DETECT ---
  const has = {
    claudeMd: existsSync(join(targetDir, 'CLAUDE.md')),
    workspaceJson: existsSync(join(targetDir, 'workspace.json')),
    settingsJson: existsSync(join(targetDir, '.claude', 'settings.json')),
    settingsLocal: existsSync(join(targetDir, '.claude', 'settings.local.json')),
    rules: existsSync(join(targetDir, '.claude', 'rules')),
    skills: existsSync(join(targetDir, '.claude', 'skills')),
    agents: existsSync(join(targetDir, '.claude', 'agents')),
    hooks: existsSync(join(targetDir, '.claude', 'hooks')),
    sharedContext: existsSync(join(targetDir, 'shared-context')),
    repos: existsSync(join(targetDir, 'repos')),
    scratchpad: existsSync(join(targetDir, '.claude-scratchpad')),
    gitignore: existsSync(join(targetDir, '.gitignore')),
    git: existsSync(join(targetDir, '.git')),
  };

  const repos = detectRepos(targetDir);

  console.log('  Detected:');
  for (const [key, val] of Object.entries(has)) {
    if (val) console.log(`    \u2713 ${key}`);
  }
  if (repos.length > 0) {
    console.log(`    \u2713 ${repos.length} repo(s): ${repos.map(r => r.name).join(', ')}`);
  }
  console.log('');

  // --- DIRECTORIES ---
  for (const dir of ['shared-context', 'shared-context/locked', 'repos', '.claude-scratchpad']) {
    const fullPath = join(targetDir, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      const keepPath = join(fullPath, '.keep');
      if (!existsSync(keepPath)) writeFileSync(keepPath, '');
      console.log(`  Created ${dir}/`);
    }
  }

  // --- COMPONENTS ---
  const components = [
    { name: 'skills', src: '.claude/skills' },
    { name: 'hooks', src: '.claude/hooks' },
    { name: 'agents', src: '.claude/agents' },
    { name: 'rules', src: '.claude/rules' },
    { name: 'recipes', src: '.claude/recipes' },
  ];

  for (const comp of components) {
    const localDir = join(targetDir, comp.src);
    const templateDir = join(TEMPLATE_DIR, comp.src);
    if (!existsSync(templateDir)) continue;

    if (!existsSync(localDir)) {
      cpSync(templateDir, localDir, { recursive: true });
      if (comp.name === 'hooks') {
        for (const f of readdirSync(localDir)) {
          if (f.endsWith('.sh')) execSync(`chmod +x "${join(localDir, f)}"`);
        }
      }
      console.log(`  Installed ${comp.name}`);
    } else if (update) {
      const templateFiles = walkDir(templateDir);
      let added = 0, updated = 0, skipped = 0;
      for (const relFile of templateFiles) {
        const localPath = join(localDir, relFile);
        const templatePath = join(templateDir, relFile);
        if (!existsSync(localPath)) {
          const dir = dirname(localPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          cpSync(templatePath, localPath);
          if (relFile.endsWith('.sh')) execSync(`chmod +x "${localPath}"`);
          added++;
        } else {
          const localContent = readFileSync(localPath, 'utf-8');
          const templateContent = readFileSync(templatePath, 'utf-8');
          if (localContent !== templateContent && !relFile.includes('local-only-')) {
            const { overwrite } = await prompts({
              type: 'confirm',
              name: 'overwrite',
              message: `  ${comp.name}/${relFile} differs. Update?`,
              initial: false,
            }, { onCancel });
            if (overwrite) {
              cpSync(templatePath, localPath);
              if (relFile.endsWith('.sh')) execSync(`chmod +x "${localPath}"`);
              updated++;
            } else { skipped++; }
          }
        }
      }
      if (added > 0 || updated > 0) {
        console.log(`  ${comp.name}: ${added} added, ${updated} updated, ${skipped} skipped`);
      }
    } else {
      // Fresh mode, component exists — add missing only
      const templateFiles = walkDir(templateDir);
      let added = 0;
      for (const relFile of templateFiles) {
        const localPath = join(localDir, relFile);
        if (!existsSync(localPath)) {
          const dir = dirname(localPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          cpSync(join(templateDir, relFile), localPath);
          if (relFile.endsWith('.sh')) execSync(`chmod +x "${localPath}"`);
          added++;
        }
      }
      if (added > 0) console.log(`  Added ${added} new files to ${comp.name}`);
    }
  }

  // --- SETTINGS.JSON ---
  const settingsPath = join(targetDir, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    cpSync(join(TEMPLATE_DIR, '.claude', 'settings.json'), settingsPath);
    console.log('  Created .claude/settings.json');
  } else if (update) {
    const localContent = readFileSync(settingsPath, 'utf-8');
    const templateContent = readFileSync(join(TEMPLATE_DIR, '.claude', 'settings.json'), 'utf-8');
    if (localContent !== templateContent) {
      const { overwrite } = await prompts({
        type: 'confirm', name: 'overwrite',
        message: 'settings.json differs. Update?', initial: false,
      }, { onCancel });
      if (overwrite) {
        cpSync(join(TEMPLATE_DIR, '.claude', 'settings.json'), settingsPath);
        console.log('  Updated .claude/settings.json');
      }
    }
  }

  // --- WORKSPACE.JSON (with initialized: false) ---
  const workspaceJsonPath = join(targetDir, 'workspace.json');
  if (!existsSync(workspaceJsonPath)) {
    const name = targetDir.split('/').pop();
    const config = {
      workspace: {
        name,
        initialized: false,
        templateVersion: JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version,
        scratchpadDir: '.claude-scratchpad',
        worktreeSuffix: '___wt-',
        sharedContextDir: 'shared-context',
        releaseNotesDir: 'release-notes',
        subagentContextMaxBytes: 10240,
        greeting: `Welcome back to ${name}.`,
        releaseMode: 'per-repo',
      },
      repos: {},
    };
    for (const repo of repos) {
      config.repos[repo.name] = {
        remote: repo.remote || 'local',
        branch: repo.branch,
      };
      if (repos.indexOf(repo) === 0) config.repos[repo.name].primary = true;
    }
    writeFileSync(workspaceJsonPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`  Created workspace.json (${repos.length} repo(s), initialized: false)`);
  }

  // --- CLAUDE.MD ---
  const claudeMdPath = join(targetDir, 'CLAUDE.md');
  if (has.claudeMd && !existsSync(claudeMdPath + '.bak')) {
    renameSync(claudeMdPath, claudeMdPath + '.bak');
    console.log('  Backed up CLAUDE.md → CLAUDE.md.bak');
  } else if (has.claudeMd) {
    console.log('  CLAUDE.md.bak already exists — skipping backup');
  }
  const name = targetDir.split('/').pop();
  const template = readFileSync(join(TEMPLATE_DIR, 'CLAUDE.md.tmpl'), 'utf-8');
  writeFileSync(claudeMdPath, template.replace(/\{\{project-name\}\}/g, name));
  console.log('  Created CLAUDE.md');

  // --- .GITIGNORE ---
  if (!existsSync(join(targetDir, '.gitignore'))) {
    cpSync(join(TEMPLATE_DIR, '_gitignore'), join(targetDir, '.gitignore'));
    console.log('  Created .gitignore');
  }

  // --- USER IDENTITY ---
  const settingsLocalPath = join(targetDir, '.claude', 'settings.local.json');
  const defaultUser = process.env.USER || process.env.USERNAME || 'user';
  if (existsSync(settingsLocalPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsLocalPath, 'utf-8'));
      if (!existing.workspace?.user) {
        const { userName } = await prompts({
          type: 'text', name: 'userName',
          message: 'Your name (for context scoping):', initial: defaultUser,
        }, { onCancel });
        if (!userName) return;
        existing.workspace = existing.workspace || {};
        existing.workspace.user = userName;
        writeFileSync(settingsLocalPath, JSON.stringify(existing, null, 2) + '\n');
        console.log('  Added user identity to settings.local.json');
      }
    } catch { console.log('  \u26A0 Could not parse settings.local.json'); }
  } else {
    const { userName } = await prompts({
      type: 'text', name: 'userName',
      message: 'Your name (for context scoping):', initial: defaultUser,
    }, { onCancel });
    if (!userName) return;
    mkdirSync(dirname(settingsLocalPath), { recursive: true });
    writeFileSync(settingsLocalPath, JSON.stringify({ workspace: { user: userName } }, null, 2) + '\n');
    console.log('  Created settings.local.json');
  }

  // --- USER DIRECTORY ---
  try {
    const settings = JSON.parse(readFileSync(settingsLocalPath, 'utf-8'));
    const user = settings.workspace?.user;
    if (user) {
      for (const dir of [`shared-context/${user}`, `shared-context/${user}/inflight`]) {
        const fullPath = join(targetDir, dir);
        if (!existsSync(fullPath)) mkdirSync(fullPath, { recursive: true });
      }
      console.log(`  Created shared-context/${user}/ and inflight/`);
    }
  } catch {}

  // --- GIT INIT ---
  if (!has.git) {
    const { initGit } = await prompts({
      type: 'confirm', name: 'initGit',
      message: 'No git repo. Initialize?', initial: true,
    }, { onCancel });
    if (initGit) {
      execSync('git init', { cwd: targetDir, stdio: 'pipe' });
      execSync('git add -A', { cwd: targetDir, stdio: 'pipe' });
      execSync('git commit -m "chore: migrate to claude-workspace template"', { cwd: targetDir, stdio: 'pipe' });
      console.log('  Initialized git repo');
    }
  }

  // --- DONE ---
  if (update) {
    console.log(`
  Template files updated. Run /workspace-update in Claude Code to
  verify integrity and complete the update.
`);
  } else {
    // Check if workspace is already initialized
    let initialized = false;
    if (existsSync(workspaceJsonPath)) {
      try {
        const ws = JSON.parse(readFileSync(workspaceJsonPath, 'utf-8'));
        initialized = ws.workspace?.initialized === true;
      } catch {}
    }
    if (initialized) {
      console.log(`
  Structure updated. Workspace is already initialized.
  Run /workspace-update in Claude Code to verify integrity.
`);
    } else {
      console.log(`
  Structure installed. Workspace is NOT initialized yet.

  Next step: open this workspace in Claude Code and run /workspace-init
  This will guide you through populating shared context, rules, and
  team knowledge from your existing content.
`);
    }
  }
}
