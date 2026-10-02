import { cpSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeBaseline, INERT_PAIRS } from '../template/_claude/scripts/template-baseline.mjs';

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

  // Ensure workspace-context/locked/ exists. canonical.md and index.md are
  // generated later by /workspace-init via build-workspace-context.mjs;
  // repos/, work-sessions/, and workspace-scratchpad/ are lazy-created when
  // scripts and hooks first need them — we do NOT pre-create them here.
  mkdirSync(join(directory, 'workspace-context', 'locked'), { recursive: true });

  // The template stores some files under inert names — _gitignore,
  // _claude/, _mcp.json — because Claude Code treats .claude/ directories
  // and .mcp.json files as protected paths and would block automated edits
  // to the template. Install each under its live name in the target.
  const inertNames = [
    { from: '_gitignore', to: '.gitignore' },
    { from: '_claude', to: '.claude' },
    { from: '_mcp.json', to: '.mcp.json' },
  ];
  for (const { from, to } of inertNames) {
    const src = join(directory, from);
    const dest = join(directory, to);
    if (!existsSync(src)) continue;
    if (existsSync(dest) && statSync(src).isDirectory()) {
      // Pre-populated target: merge into the existing directory — template
      // files overwrite same-named ones, extra local files survive — then
      // drop the inert copy.
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true });
    } else {
      renameSync(src, dest);
    }
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

  // Record the template baseline — the sha256 of every verbatim-installed
  // file — so /workspace-update can classify three ways (workspace vs payload
  // vs baseline) instead of treating every template change as a local edit
  // (gh:183). The template tree carries the inert names; entries always hold
  // the template's content, so hashes come straight from the source of truth.
  writeBaseline(directory, TEMPLATE_DIR, { pairs: INERT_PAIRS, version: pkgJson.version });

  return directory;
}
