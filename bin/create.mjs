#!/usr/bin/env node

import { runPrompts } from '../lib/prompts.mjs';
import { scaffold } from '../lib/scaffold.mjs';
import { initGit, cloneRepos } from '../lib/git.mjs';
import { migrate } from '../lib/migrate.mjs';
import { resolve } from 'path';

async function main() {
  console.log('\n  create-claude-workspace\n');

  // Check for --migrate flag
  const migrateFlag = process.argv.includes('--migrate');

  if (migrateFlag) {
    const targetDir = resolve(process.argv[process.argv.indexOf('--migrate') + 1] || '.');
    await migrate(targetDir);
    return;
  }

  const answers = await runPrompts();

  if (!answers) {
    console.log('Setup cancelled.');
    process.exit(0);
  }

  const workspacePath = await scaffold(answers);
  await initGit(workspacePath);

  if (answers.repos.length > 0) {
    await cloneRepos(workspacePath, answers.repos);
  }

  console.log(`
  \u2713 Workspace created at ${workspacePath}
  \u2713 Git repo initialized${answers.repos.length > 0 ? `\n  \u2713 ${answers.repos.length} repo(s) cloned to repos/` : ''}

  Next steps:
    cd ${workspacePath}
    claude
    /start-work blank
  `);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
