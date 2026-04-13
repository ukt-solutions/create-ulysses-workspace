import { cpSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', 'template');

export async function scaffold(answers) {
  const { name, directory, repos, userName, activateRules } = answers;

  // Create target directory
  mkdirSync(directory, { recursive: true });

  // Copy template files
  cpSync(TEMPLATE_DIR, directory, {
    recursive: true,
    filter: (src) => {
      // Skip .tmpl files — we'll process them separately
      return !src.endsWith('.tmpl');
    },
  });

  // Ensure shared-context/locked/ exists so the CLAUDE.md import resolves.
  // repos/, work-sessions/, and workspace-scratchpad/ are lazy-created when
  // scripts and hooks first need them — we do NOT pre-create them here.
  mkdirSync(join(directory, 'shared-context', 'locked'), { recursive: true });

  // Rename _gitignore to .gitignore
  const gitignoreSrc = join(directory, '_gitignore');
  const gitignoreDest = join(directory, '.gitignore');
  if (existsSync(gitignoreSrc)) {
    renameSync(gitignoreSrc, gitignoreDest);
  }

  // Process CLAUDE.md template
  const claudeMdTmpl = readFileSync(join(TEMPLATE_DIR, 'CLAUDE.md.tmpl'), 'utf-8');
  const claudeMd = claudeMdTmpl.replace(/\{\{project-name\}\}/g, name);
  writeFileSync(join(directory, 'CLAUDE.md'), claudeMd);

  // Process workspace.json template
  const workspaceJsonTmpl = readFileSync(join(TEMPLATE_DIR, 'workspace.json.tmpl'), 'utf-8');
  const workspaceConfig = JSON.parse(workspaceJsonTmpl.replace(/\{\{project-name\}\}/g, name));

  // Stamp template version
  const pkgJson = JSON.parse(readFileSync(join(TEMPLATE_DIR, '..', 'package.json'), 'utf-8'));
  workspaceConfig.workspace.templateVersion = pkgJson.version;

  // Populate repos
  for (const repo of repos) {
    workspaceConfig.repos[repo.name] = {
      remote: repo.remote,
      branch: repo.branch,
    };
    if (repo.primary) {
      workspaceConfig.repos[repo.name].primary = true;
    }
  }
  writeFileSync(
    join(directory, 'workspace.json'),
    JSON.stringify(workspaceConfig, null, 2) + '\n'
  );

  // Write settings.local.json with user identity
  const settingsLocal = {
    workspace: {
      user: userName,
    },
  };
  writeFileSync(
    join(directory, '.claude', 'settings.local.json'),
    JSON.stringify(settingsLocal, null, 2) + '\n'
  );

  // Activate selected optional rules (rename .md.skip → .md)
  for (const rule of activateRules) {
    const skipPath = join(directory, '.claude', 'rules', `${rule}.md.skip`);
    const activePath = join(directory, '.claude', 'rules', `${rule}.md`);
    if (existsSync(skipPath)) {
      renameSync(skipPath, activePath);
    }
  }

  return directory;
}
