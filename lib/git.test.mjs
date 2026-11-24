#!/usr/bin/env node
// Unit tests for git.mjs
// Run: node lib/git.test.mjs
//
// initGit and cloneRepos run during `--init`; the repo remotes come from the
// init prompts, so they are untrusted input. The malicious remotes below
// carry a shell payload and an option that git would read as a flag. The
// process runs with its cwd inside the temp directory, so a payload that
// escaped into a shell would create PWNED where the assertions look.
import { initGit, cloneRepos } from './git.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let failed = 0;
let passed = 0;
function check(label, ok) {
  if (ok) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

const startCwd = process.cwd();
const base = realpathSync(mkdtempSync(join(tmpdir(), 'git-test-')));

// Hermetic git: a fixed identity and an empty global config, so the user's
// signing, hooks, or default-branch settings cannot change the outcome.
writeFileSync(join(base, 'gitconfig'), '');
const savedEnv = {};
const hermetic = {
  GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
for (const [k, v] of Object.entries(hermetic)) { savedEnv[k] = process.env[k]; process.env[k] = v; }

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });

// Every entry under dir (outside .git) named PWNED*: a payload that ran.
function findPwned(dir) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      if (/^PWNED/.test(e.name)) hits.push(join(d, e.name));
      if (e.isDirectory()) walk(join(d, e.name));
    }
  };
  walk(dir);
  return hits;
}

// Silence and record the console during a call.
async function quietly(fn) {
  const logs = [];
  const warns = [];
  const { log, warn } = console;
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => warns.push(a.join(' '));
  try { await fn(); } finally { console.log = log; console.warn = warn; }
  return { logs, warns };
}

let bare; // a local bare repository the clone cases use as a valid remote

try {
  // initGit: a repo with one commit holding the workspace files.
  {
    const ws = join(base, 'ws');
    mkdirSync(ws);
    writeFileSync(join(ws, 'README.md'), '# ws\n');
    await initGit(ws);
    check('initGit creates a repository', existsSync(join(ws, '.git')));
    check('initGit makes exactly one commit', git(ws, 'rev-list', '--count', 'HEAD').trim() === '1');
    check('initGit commit message', git(ws, 'log', '-1', '--format=%s').trim() === 'chore: initialize claude-workspace');
    check('initGit commits the workspace files', git(ws, 'ls-files').trim() === 'README.md');
  }

  // cloneRepos: a local bare repository clones into repos/<name>.
  {
    const seed = join(base, 'seed');
    bare = join(base, 'good.git');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    writeFileSync(join(seed, 'README.md'), '# good\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'init');
    git(base, 'clone', '-q', '--bare', seed, bare);

    const ws = join(base, 'clone-ws');
    mkdirSync(ws);
    process.chdir(ws);
    await quietly(() => cloneRepos(ws, [{ name: 'good', remote: bare }]));
    process.chdir(startCwd);
    check('cloneRepos clones a local remote', existsSync(join(ws, 'repos', 'good', '.git')));
    check('cloneRepos checks out the files', existsSync(join(ws, 'repos', 'good', 'README.md')));
  }

  // cloneRepos: the repo name becomes a directory under repos/, so a name
  // with a separator or dots is skipped — even with a perfectly good remote.
  {
    const ws = join(base, 'names-ws');
    mkdirSync(ws);
    process.chdir(ws);
    const names = ['../escaped', 'a/b', 'a\\b', '.', '..', '', '/abs'];
    let threw = false;
    let out = { logs: [], warns: [] };
    try {
      out = await quietly(() => cloneRepos(ws, names.map((name) => ({ name, remote: bare }))));
    } catch { threw = true; }
    process.chdir(startCwd);
    check('cloneRepos does not throw on invalid repo names', !threw);
    check('nothing is cloned outside repos/', !existsSync(join(ws, 'escaped')) && !existsSync(join(base, 'escaped')));
    check('nothing is cloned for any invalid name',
      !existsSync(join(ws, 'repos')) || readdirSync(join(ws, 'repos')).length === 0);
    check('each invalid repo name is reported',
      out.warns.filter((w) => /invalid repo name/i.test(w)).length === names.length,
      `warnings: ${JSON.stringify(out.warns)}`);
    // A dotted but ordinary name is fine.
    process.chdir(ws);
    await quietly(() => cloneRepos(ws, [{ name: '.dotted', remote: bare }]));
    process.chdir(startCwd);
    check('a leading-dot name is still a valid single segment', existsSync(join(ws, 'repos', '.dotted', '.git')));
  }

  // cloneRepos: untrusted remotes are never read as shell text or as options.
  {
    const ws = join(base, 'evil-ws');
    mkdirSync(ws);
    process.chdir(ws);
    let threw = false;
    let out = { logs: [], warns: [] };
    try {
      out = await quietly(() => cloneRepos(ws, [
        { name: 'bad', remote: 'x"; touch PWNED; "' },
        { name: 'opt', remote: '--upload-pack=touch PWNED2' },
        { name: 'empty', remote: '' },
      ]));
    } catch { threw = true; }
    process.chdir(startCwd);
    check('cloneRepos does not throw on malicious remotes', !threw);
    check('no payload ran', findPwned(base).length === 0);
    check('payload remote clones nothing', !existsSync(join(ws, 'repos', 'bad', '.git')));
    check('option-shaped remote is reported as invalid',
      out.warns.some((w) => /invalid remote/i.test(w) && w.includes('opt')));
    check('empty remote is reported as invalid',
      out.warns.some((w) => /invalid remote/i.test(w) && w.includes('empty')));
    check('option-shaped remote clones nothing', !existsSync(join(ws, 'repos', 'opt')));
  }
} finally {
  process.chdir(startCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
