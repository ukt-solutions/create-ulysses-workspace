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
    const gitDir = join(fullPath, '.git');
    if (existsSync(gitDir)) {
      let remote = '';
      try {
        remote = execSync(`git -C "${fullPath}" remote get-url origin`, { encoding: 'utf-8' }).trim();
      } catch {}
      let branch = 'main';
      try {
        branch = execSync(`git -C "${fullPath}" branch --show-current`, { encoding: 'utf-8' }).trim();
      } catch {}
      repos.push({ name: entry, remote, branch, path: fullPath });
    }
  }
  return repos;
}

function findNonStandardDirs(targetDir) {
  const standard = new Set(['.claude', '.claude-scratchpad', '.git', '.gitignore', '.idea',
    'repos', 'shared-context', 'CLAUDE.md', 'workspace.json', '.DS_Store',
    '.mcp.json', '.superpowers', '.playwright-mcp', 'node_modules']);
  const flagged = [];
  for (const entry of readdirSync(targetDir)) {
    if (standard.has(entry)) continue;
    if (entry.startsWith('.')) continue;
    flagged.push(entry);
  }
  return flagged;
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
  const mode = update ? 'update' : 'fresh';

  console.log(`\n  create-claude-workspace --migrate${update ? ' --update' : ''}`);
  console.log(`  Target: ${targetDir}`);
  console.log(`  Mode: ${mode}\n`);

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
    mcpJson: existsSync(join(targetDir, '.mcp.json')),
    workspaceArtifacts: existsSync(join(targetDir, 'workspace-artifacts')),
  };

  const repos = detectRepos(targetDir);
  const nonStandardDirs = findNonStandardDirs(targetDir);

  console.log('  Detected:');
  for (const [key, val] of Object.entries(has)) {
    if (val) console.log(`    \u2713 ${key}`);
  }
  if (repos.length > 0) {
    console.log(`    \u2713 ${repos.length} repo(s): ${repos.map(r => r.name).join(', ')}`);
  }
  if (nonStandardDirs.length > 0) {
    console.log(`    \u26A0 Non-standard at root: ${nonStandardDirs.join(', ')}`);
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

  // --- COMPONENTS (skills, hooks, agents, rules) ---
  const components = [
    { name: 'skills', src: '.claude/skills' },
    { name: 'hooks', src: '.claude/hooks' },
    { name: 'agents', src: '.claude/agents' },
    { name: 'rules', src: '.claude/rules' },
  ];

  for (const comp of components) {
    const localDir = join(targetDir, comp.src);
    const templateDir = join(TEMPLATE_DIR, comp.src);

    if (!existsSync(localDir)) {
      const { install } = await prompts({
        type: 'confirm',
        name: 'install',
        message: `Install ${comp.name}?`,
        initial: true,
      }, { onCancel });
      if (install === undefined) return;
      if (install) {
        cpSync(templateDir, localDir, { recursive: true });
        if (comp.name === 'hooks') {
          for (const f of readdirSync(localDir)) {
            if (f.endsWith('.sh')) execSync(`chmod +x "${join(localDir, f)}"`);
          }
        }
        console.log(`  Installed ${comp.name}`);
      }
    } else {
      // Component exists — sync files
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
        } else if (update) {
          const localContent = readFileSync(localPath, 'utf-8');
          const templateContent = readFileSync(templatePath, 'utf-8');
          if (localContent !== templateContent) {
            if (relFile.includes('local-only-')) { skipped++; continue; }
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
            } else {
              skipped++;
            }
          }
        }
      }
      if (added > 0 || updated > 0) {
        console.log(`  ${comp.name}: ${added} added, ${updated} updated, ${skipped} skipped`);
      }
    }
  }

  // --- SETTINGS.JSON (team) ---
  const settingsPath = join(targetDir, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    cpSync(join(TEMPLATE_DIR, '.claude', 'settings.json'), settingsPath);
    console.log('  Created .claude/settings.json (hooks configured)');
  } else if (update) {
    const localContent = readFileSync(settingsPath, 'utf-8');
    const templateContent = readFileSync(join(TEMPLATE_DIR, '.claude', 'settings.json'), 'utf-8');
    if (localContent !== templateContent) {
      const { overwrite } = await prompts({
        type: 'confirm',
        name: 'overwrite',
        message: 'settings.json differs from template. Update?',
        initial: false,
      }, { onCancel });
      if (overwrite) {
        cpSync(join(TEMPLATE_DIR, '.claude', 'settings.json'), settingsPath);
        console.log('  Updated .claude/settings.json');
      }
    }
  }

  // --- WORKSPACE.JSON ---
  const workspaceJsonPath = join(targetDir, 'workspace.json');
  if (!existsSync(workspaceJsonPath)) {
    const name = targetDir.split('/').pop();
    const config = {
      workspace: {
        name,
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
      if (repos.indexOf(repo) === 0) {
        config.repos[repo.name].primary = true;
      }
    }
    writeFileSync(workspaceJsonPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`  Created workspace.json (${repos.length} repo(s) detected)`);
  }

  // --- CLAUDE.MD ---
  const claudeMdPath = join(targetDir, 'CLAUDE.md');
  if (has.claudeMd) {
    const { replace } = await prompts({
      type: 'confirm',
      name: 'replace',
      message: 'CLAUDE.md exists. Replace with template? (backup: CLAUDE.md.bak)',
      initial: true,
    }, { onCancel });
    if (replace) {
      renameSync(claudeMdPath, claudeMdPath + '.bak');
      const name = targetDir.split('/').pop();
      const template = readFileSync(join(TEMPLATE_DIR, 'CLAUDE.md.tmpl'), 'utf-8');
      writeFileSync(claudeMdPath, template.replace(/\{\{project-name\}\}/g, name));
      console.log('  Replaced CLAUDE.md (backup: CLAUDE.md.bak)');
    }
  } else {
    const name = targetDir.split('/').pop();
    const template = readFileSync(join(TEMPLATE_DIR, 'CLAUDE.md.tmpl'), 'utf-8');
    writeFileSync(claudeMdPath, template.replace(/\{\{project-name\}\}/g, name));
    console.log('  Created CLAUDE.md');
  }

  // --- .GITIGNORE ---
  if (!existsSync(join(targetDir, '.gitignore'))) {
    cpSync(join(TEMPLATE_DIR, '_gitignore'), join(targetDir, '.gitignore'));
    console.log('  Created .gitignore');
  }

  // --- USER IDENTITY ---
  const settingsLocalPath = join(targetDir, '.claude', 'settings.local.json');
  if (existsSync(settingsLocalPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsLocalPath, 'utf-8'));
      if (!existing.workspace?.user) {
        const defaultUser = process.env.USER || process.env.USERNAME || 'user';
        const { userName } = await prompts({
          type: 'text',
          name: 'userName',
          message: 'Your name (for context scoping):',
          initial: defaultUser,
        }, { onCancel });
        if (!userName) return;
        existing.workspace = existing.workspace || {};
        existing.workspace.user = userName;
        writeFileSync(settingsLocalPath, JSON.stringify(existing, null, 2) + '\n');
        console.log('  Added user identity to settings.local.json');
      }
    } catch {
      console.log('  \u26A0 Could not parse settings.local.json');
    }
  } else {
    const defaultUser = process.env.USER || process.env.USERNAME || 'user';
    const { userName } = await prompts({
      type: 'text',
      name: 'userName',
      message: 'Your name (for context scoping):',
      initial: defaultUser,
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
      type: 'confirm',
      name: 'initGit',
      message: 'No git repo. Initialize?',
      initial: true,
    }, { onCancel });
    if (initGit) {
      execSync('git init', { cwd: targetDir, stdio: 'pipe' });
      execSync('git add -A', { cwd: targetDir, stdio: 'pipe' });
      execSync('git commit -m "chore: migrate to claude-workspace template"', { cwd: targetDir, stdio: 'pipe' });
      console.log('  Initialized git repo with initial commit');
    }
  }

  // --- POST-MIGRATION REPORT ---
  const postActions = [];

  if (nonStandardDirs.length > 0) {
    postActions.push(`Non-standard directories at root: ${nonStandardDirs.join(', ')}`,
      '  → Move to repos/ (if project code), .claude-scratchpad/ (if disposable), or shared-context/ (if worth keeping)');
  }
  if (has.mcpJson) {
    const mcpContent = readFileSync(join(targetDir, '.mcp.json'), 'utf-8');
    if (mcpContent.toLowerCase().includes('notion')) {
      postActions.push('.mcp.json found with Notion MCP server',
        '  → Follow recipe: docs/recipes/migrate-from-notion.md',
        '  → Run /migrate in Claude Code BEFORE removing the MCP server');
    } else {
      postActions.push('.mcp.json found — external service dependencies detected',
        '  → Extract any content you need into shared-context/ before removing');
    }
  }
  if (has.workspaceArtifacts) {
    postActions.push('workspace-artifacts/ found — pre-template scratch directory',
      '  → Move useful files to .claude-scratchpad/ or shared-context/, delete the rest');
  }
  if (has.git) {
    let hasRemote = false;
    try {
      const remote = execSync('git remote get-url origin', { cwd: targetDir, encoding: 'utf-8' }).trim();
      if (remote) hasRemote = true;
    } catch {}
    if (!hasRemote) {
      postActions.push('No remote configured for workspace repo',
        '  → Create with: gh repo create {org}/{name} --private --source=. --push');
    }
  }

  if (postActions.length > 0) {
    console.log('\n  Post-migration actions (handle these in Claude Code):');
    for (const action of postActions) {
      console.log(`    ${action.startsWith('  →') ? action : '\u26A0 ' + action}`);
    }
  }

  console.log('\n  Migration complete. Open this workspace in Claude Code to handle post-migration actions.\n');
}
