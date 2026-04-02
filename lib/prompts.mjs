import prompts from 'prompts';
import { homedir } from 'os';
import { join } from 'path';

export async function runPrompts() {
  const onCancel = () => {
    return false;
  };

  // Workspace name
  const { name } = await prompts({
    type: 'text',
    name: 'name',
    message: 'Workspace name:',
    validate: (v) => (v.trim() ? true : 'Name is required'),
  }, { onCancel });
  if (!name) return null;

  // Directory
  const defaultDir = join(homedir(), 'claude-workspaces', name);
  const { directory } = await prompts({
    type: 'text',
    name: 'directory',
    message: 'Directory:',
    initial: defaultDir,
  }, { onCancel });
  if (!directory) return null;

  // Repos
  const repos = [];
  let addMore = true;
  while (addMore) {
    const { addRepo } = await prompts({
      type: 'confirm',
      name: 'addRepo',
      message: repos.length === 0 ? 'Add a repository?' : 'Add another repository?',
      initial: repos.length === 0,
    }, { onCancel });
    if (addRepo === undefined) return null;

    if (!addRepo) {
      addMore = false;
      break;
    }

    const repoAnswers = await prompts([
      {
        type: 'text',
        name: 'remote',
        message: '  Remote URL:',
        validate: (v) => (v.trim() ? true : 'URL is required'),
      },
      {
        type: 'text',
        name: 'branch',
        message: '  Default branch:',
        initial: 'main',
      },
      {
        type: 'confirm',
        name: 'primary',
        message: '  Primary repo?',
        initial: repos.length === 0,
      },
    ], { onCancel });
    if (!repoAnswers.remote) return null;

    // Extract repo name from remote URL
    const repoName = repoAnswers.remote
      .split('/')
      .pop()
      .replace(/\.git$/, '');

    repos.push({ name: repoName, ...repoAnswers });
  }

  // User name
  const defaultUser = process.env.USER || process.env.USERNAME || 'user';
  const { userName } = await prompts({
    type: 'text',
    name: 'userName',
    message: 'Your name (for handoff scoping):',
    initial: defaultUser,
  }, { onCancel });
  if (!userName) return null;

  // Optional rules
  const skipRules = [
    { title: 'cloud-infrastructure', value: 'cloud-infrastructure' },
    { title: 'superpowers-workflow', value: 'superpowers-workflow' },
    { title: 'documentation', value: 'documentation' },
    { title: 'memory-guidance', value: 'memory-guidance' },
    { title: 'context-discipline', value: 'context-discipline' },
    { title: 'scope-guard', value: 'scope-guard' },
    { title: 'token-economics', value: 'token-economics' },
    { title: 'agent-rules', value: 'agent-rules' },
  ];

  const { activateRules } = await prompts({
    type: 'multiselect',
    name: 'activateRules',
    message: 'Activate optional rules:',
    choices: skipRules,
    hint: '- Space to select, Enter to confirm',
  }, { onCancel });
  if (!activateRules) return null;

  return {
    name,
    directory,
    repos,
    userName,
    activateRules,
  };
}
