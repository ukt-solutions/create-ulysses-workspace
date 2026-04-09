import { execSync } from 'child_process';
import { join } from 'path';

export async function initGit(workspacePath) {
  execSync('git init', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git add -A', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git commit -m "chore: initialize claude-workspace"', {
    cwd: workspacePath,
    stdio: 'pipe',
  });
}

export async function cloneRepos(workspacePath, repos) {
  const reposDir = join(workspacePath, 'repos');

  for (const repo of repos) {
    const targetDir = join(reposDir, repo.name);
    console.log(`  Cloning ${repo.name}...`);
    try {
      execSync(`git clone "${repo.remote}" "${targetDir}"`, { stdio: 'pipe' });
    } catch (err) {
      console.warn(`  \u26A0 Failed to clone ${repo.name}: ${err.message}`);
      console.warn(`    You can clone it manually later or run /setup in Claude Code.`);
    }
  }
}
