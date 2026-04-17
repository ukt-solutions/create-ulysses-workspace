#!/usr/bin/env node

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 9)) {
  console.error(`@ulysses/create-workspace requires Node.js 20.9 or later.`);
  console.error(`  You have:  ${process.versions.node}`);
  console.error(`  Required:  >=20.9.0`);
  console.error(`  Try installing a newer Node via nvm, fnm, or the Node website.`);
  process.exit(1);
}

import { runPrompts } from '../lib/prompts.mjs';
import { scaffold } from '../lib/scaffold.mjs';
import { initGit, cloneRepos } from '../lib/git.mjs';
import { resolve } from 'path';

async function main() {
  console.log('\n  Ulysses Workspace\n');

  const initFlag = process.argv.includes('--init');
  const upgradeFlag = process.argv.includes('--upgrade');
  const migrateFlag = process.argv.includes('--migrate');

  // Deprecated --migrate
  if (migrateFlag) {
    console.error('  --migrate is deprecated. Use --init (fresh install) or --upgrade (template update).');
    console.error('');
    console.error('  Fresh install:    npx @ulysses/create-workspace --init [target-dir]');
    console.error('  Template update:  npx @ulysses/create-workspace --upgrade [target-dir]');
    console.error('');
    process.exit(1);
  }

  if (initFlag) {
    const { initWorkspace } = await import('../lib/init.mjs');
    const args = process.argv.slice(process.argv.indexOf('--init') + 1);
    const targetDir = resolve(args.find(a => !a.startsWith('--')) || '.');
    await initWorkspace(targetDir);
    return;
  }

  if (upgradeFlag) {
    const { upgradeWorkspace } = await import('../lib/upgrade.mjs');
    const args = process.argv.slice(process.argv.indexOf('--upgrade') + 1);
    const targetDir = resolve(args.find(a => !a.startsWith('--')) || '.');
    await upgradeWorkspace(targetDir);
    return;
  }

  // Default: interactive scaffold
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
