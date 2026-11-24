import { execFileSync } from 'child_process';
import { join } from 'path';

export async function initGit(workspacePath) {
  execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: workspacePath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'chore: initialize claude-workspace'], {
    cwd: workspacePath,
    stdio: 'pipe',
  });
}

export async function cloneRepos(workspacePath, repos) {
  const reposDir = join(workspacePath, 'repos');

  for (const repo of repos) {
    const targetDir = join(reposDir, repo.name);
    console.log(`  Cloning ${repo.name}...`);
    // The remote is typed at a prompt and reaches git as a literal argument,
    // never shell text. A leading dash would read as a git option (for
    // example --upload-pack=...), so such a remote is skipped, and `--`
    // keeps any other value positional.
    if (typeof repo.remote !== 'string' || repo.remote === '' || repo.remote.startsWith('-')) {
      console.warn(`  ⚠ Skipping ${repo.name}: invalid remote ${JSON.stringify(repo.remote)}`);
      console.warn(`    Fix the remote and clone it manually later or run /setup in Claude Code.`);
      continue;
    }
    try {
      execFileSync('git', ['clone', '--', repo.remote, targetDir], { stdio: 'pipe' });
    } catch (err) {
      console.warn(`  ⚠ Failed to clone ${repo.name}: ${err.message}`);
      console.warn(`    You can clone it manually later or run /setup in Claude Code.`);
    }
  }
}
