import { execFileSync } from 'child_process';
import { isAbsolute, join } from 'path';

export async function initGit(workspacePath) {
  execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: workspacePath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'chore: initialize claude-workspace'], {
    cwd: workspacePath,
    stdio: 'pipe',
  });
}

// A repo name becomes a directory under repos/: one path segment, not dots,
// not absolute. "../x", "a/b" and "" would clone outside repos/ or into it.
function isRepoSegment(name) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) return false;
  const segs = name.split(/[\\/]/);
  return segs.length === 1 && !/^\.+$/.test(segs[0]);
}

export async function cloneRepos(workspacePath, repos) {
  const reposDir = join(workspacePath, 'repos');

  for (const repo of repos) {
    if (!isRepoSegment(repo.name)) {
      console.warn(`  \u26A0 Skipping ${JSON.stringify(repo.name)}: invalid repo name (it must be a single folder name)`);
      continue;
    }
    const targetDir = join(reposDir, repo.name);
    console.log(`  Cloning ${repo.name}...`);
    // The remote is typed at a prompt and reaches git as a literal argument,
    // never shell text. A leading dash would read as a git option (for
    // example --upload-pack=...), so such a remote is skipped, and `--`
    // keeps any other value positional.
    if (typeof repo.remote !== 'string' || repo.remote === '' || repo.remote.startsWith('-')) {
      console.warn(`  \u26A0 Skipping ${repo.name}: invalid remote ${JSON.stringify(repo.remote)}`);
      console.warn(`    Fix the remote and clone it manually later or run /setup in Claude Code.`);
      continue;
    }
    try {
      execFileSync('git', ['clone', '--', repo.remote, targetDir], { stdio: 'pipe' });
    } catch (err) {
      console.warn(`  \u26A0 Failed to clone ${repo.name}: ${err.message}`);
      console.warn(`    You can clone it manually later or run /setup in Claude Code.`);
    }
  }
}
