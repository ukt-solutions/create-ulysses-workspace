#!/usr/bin/env node
// End-to-end test for the interactive scaffold: bin/create.mjs, answered
// through its prompts the way a user does.
// Run: node lib/scaffold-cli.test.mjs
//
// lib/scaffold.test.mjs covers what scaffold() writes. This covers the run
// the `npm create` form gives a user: the questions, and what the directory
// they name looks like afterwards.
//
// The scaffold only writes into an empty directory, and the Directory prompt
// is where a user finds out. Pointed at a directory that already has files,
// it has to say so and name `--init` as the form for that, and ask nothing
// else until the answer is a directory that can be used. Whatever the user
// does from there, the files already in the first directory stay as they
// were (ulysses-workspace#223). A freshly created, empty repository still
// takes a scaffold.
//
// Answers cannot be piped in all at once: prompts reads a whole chunk as
// keystrokes for whichever question is open, so everything after the first
// answer lands in the first box. Each answer is written once its question
// has been printed.
import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

// The CLI imports the prompts package; without it nothing below can run.
try {
  createRequire(import.meta.url).resolve('prompts');
} catch {
  console.error('  FAIL: bin/create.mjs imports the prompts package and it is not installed here. Run `npm install` first.');
  process.exit(1);
}

let failed = 0;
let passed = 0;
function check(label, ok) {
  if (ok) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'create.mjs');
const templateDir = join(here, '..', 'template');

// Everything under dir as "path from dir → bytes", compared byte for byte.
// Line endings are never normalized: a CRLF file has to come out exactly as
// it went in.
function snapshot(dir, prefix = '') {
  const files = {};
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, snapshot(join(dir, entry.name), rel));
    else files[rel] = readFileSync(join(dir, entry.name));
  }
  return files;
}

// The paths whose bytes or presence differ between two snapshots.
function differences(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((rel) => !before[rel] || !after[rel] || !before[rel].equals(after[rel]));
}

// The two files the scaffold used to replace first. The .gitignore carries
// CRLF, as it would on a Windows checkout.
const OWN_GITIGNORE = '# keep build output out of git\r\nbuild/\r\n.env\r\n';
const OWN_MCP = `${JSON.stringify({ mcpServers: { 'team-tools': { command: 'npx', args: ['team-mcp'] } } }, null, 2)}\n`;

const NAME = { waitFor: 'Workspace name:', answer: 'demo\n' };
const DIRECTORY = { waitFor: 'Directory:' };
const REFUSED = { waitFor: 'already has files' };
const NO_REPO = { waitFor: 'Add a repository?', answer: 'n' };
const USER = { waitFor: 'Your name (for handoff scoping):', answer: 'tester\n' };
const NO_RULES = { waitFor: 'Activate optional rules:', answer: '\n' };

/**
 * One run of the CLI. Each step waits for a piece of output — a question, or
 * the refusal under the Directory prompt — then writes its answer. A step
 * with `either` waits for whichever of several comes first and answers that
 * one, so one script covers a run that can diverge. Returns the exit status,
 * the output with its ANSI sequences stripped, and how many steps were
 * reached; a run that has to be killed never reports more.
 */
async function runCli(steps, env) {
  const child = spawn(process.execPath, [cli], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const finished = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
  let out = '';
  let err = '';
  let reached = 0;
  let searched = 0;
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.stdout.on('data', (chunk) => {
    out += chunk;
    for (;;) {
      const step = steps[reached];
      if (!step) return;
      const first = (step.either || [step])
        .map((alt) => ({ alt, at: out.indexOf(alt.waitFor, searched) }))
        .filter((hit) => hit.at !== -1)
        .sort((a, b) => a.at - b.at)[0];
      if (!first) return;
      searched = first.at + first.alt.waitFor.length;
      child.stdin.write(first.alt.answer);
      reached++;
      // The CLI does not exit while its stdin pipe is held open, so the last
      // answer closes it.
      if (reached === steps.length) child.stdin.end();
    }
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 60000);
  const exit = await finished;
  clearTimeout(watchdog);
  return { ...exit, reached, steps: steps.length, err, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') };
}

// After a run with a failed check, show what the CLI printed: which questions
// it reached is usually the answer.
function report(run, failuresBefore) {
  if (failed === failuresBefore) return;
  console.error(`    exit ${run.code ?? run.signal}, reached step ${run.reached} of ${run.steps}`);
  for (const line of run.out.slice(-600).split('\n')) console.error(`    | ${line.slice(0, 200)}`);
  if (run.err) console.error(`    stderr: ${run.err.slice(-400)}`);
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'scaffold-cli-test-')));

// Hermetic git for the commits the CLI makes: a fixed identity and an empty
// global config, so the user's signing, hooks or default-branch settings
// cannot change the outcome.
writeFileSync(join(base, 'gitconfig'), '');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
// The same query when the repository may not be in the state asked about —
// a run that failed leaves no commit to list. '' then, so the run fails its
// check instead of taking the whole test down.
const gitState = (cwd, args) => {
  try {
    return git(cwd, args);
  } catch {
    return '';
  }
};

// The bytes of a file that may be gone — undefined then, so a missing file
// fails its check instead of ending the test.
const bytesOf = (path) => (existsSync(path) ? readFileSync(path) : undefined);

// The directory a user already has.
const existing = join(base, 'existing-project');
mkdirSync(existing);
writeFileSync(join(existing, '.gitignore'), OWN_GITIGNORE);
writeFileSync(join(existing, '.mcp.json'), OWN_MCP);
const existingBefore = snapshot(existing);
const changesTo = (dir, before) => differences(before, snapshot(dir));

try {
  // ---- A directory that already has files: the files have to survive ----
  // Two runs are possible from the Directory prompt, and the script follows
  // either. The scaffold refuses the directory and the user backs out with
  // Ctrl-C. Or it is accepted, the rest is answered and the run completes —
  // what happened before there was a refusal, and when the files went.
  // Whichever it is, .gitignore and .mcp.json have to come out as they went
  // in, and so does everything else in the directory.
  let failuresBefore = failed;
  const backedOut = await runCli([
    NAME,
    { ...DIRECTORY, answer: `${existing}\n` },
    {
      either: [
        { ...REFUSED, answer: '\x03' },        // Ctrl-C
        { ...NO_REPO },                        // accepted: answer on, as a user would
      ],
    },
    USER,
    NO_RULES,
  ], env);

  check('the Directory prompt refuses the directory and names it',
    backedOut.out.includes(resolve(existing)) && backedOut.out.includes('already has files'));
  check('the refusal names the alternative: --init <dir>',
    backedOut.out.includes('npx @ulysses-ai/create-workspace@beta --init <dir>'));
  check('no later question is asked', !backedOut.out.includes('Add a repository?'));
  check('the run ends when the user presses Ctrl-C at the refusal', backedOut.signal === null && backedOut.reached === 3);
  check('backing out is a cancellation, not an error', backedOut.code === 0 && backedOut.out.includes('Setup cancelled.'));
  check('.gitignore survives, byte for byte', bytesOf(join(existing, '.gitignore'))?.equals(Buffer.from(OWN_GITIGNORE)));
  check('.mcp.json survives, byte for byte', bytesOf(join(existing, '.mcp.json'))?.equals(Buffer.from(OWN_MCP)));
  check('nothing was written to the directory', changesTo(existing, existingBefore).length === 0);
  report(backedOut, failuresBefore);

  // ---- The same, at the default directory ----
  // A workspace of that name already exists under ~/claude-workspaces, and
  // the user accepts the suggested directory with Enter.
  failuresBefore = failed;
  const taken = join(base, 'claude-workspaces', 'demo');
  mkdirSync(taken, { recursive: true });
  writeFileSync(join(taken, '.gitignore'), OWN_GITIGNORE);
  writeFileSync(join(taken, '.mcp.json'), OWN_MCP);
  const takenBefore = snapshot(taken);
  const defaulted = await runCli([
    NAME,
    { ...DIRECTORY, answer: '\n' },
    { ...REFUSED, answer: '\x03' }, // Ctrl-C
  ], { ...env, HOME: base, USERPROFILE: base });

  check('the suggested directory is refused the same way when it already has files',
    defaulted.signal === null && defaulted.reached === 3 && defaulted.out.includes(resolve(taken)));
  check('and it is left as it was', changesTo(taken, takenBefore).length === 0);
  report(defaulted, failuresBefore);

  // ---- Refused, and the user names a directory that can be used ----
  failuresBefore = failed;
  const created = join(base, 'new-workspace');
  const existingBeforeThisRun = snapshot(existing);
  const redirected = await runCli([
    NAME,
    { ...DIRECTORY, answer: `${existing}\n` },
    { ...REFUSED, answer: `\x07${created}\n` }, // Ctrl+G clears the refused path first
    NO_REPO,
    USER,
    NO_RULES,
  ], env);

  check('the run goes on to the remaining questions, and completes',
    redirected.signal === null && redirected.reached === 6 && redirected.code === 0);
  check('the workspace is reported as created', redirected.out.includes('Workspace created at'));
  check('the directory that already had files is untouched', changesTo(existing, existingBeforeThisRun).length === 0);
  check('the new directory is created with the template\'s .gitignore and .mcp.json, byte for byte',
    existsSync(join(created, '.gitignore')) && existsSync(join(created, '.mcp.json'))
    && readFileSync(join(created, '.gitignore')).equals(readFileSync(join(templateDir, '_gitignore')))
    && readFileSync(join(created, '.mcp.json')).equals(readFileSync(join(templateDir, '_mcp.json'))));
  const tracked = gitState(created, ['ls-files']).split('\n').filter(Boolean);
  check('the commit the CLI makes tracks the workspace files, and not the staged payload',
    ['CLAUDE.md', 'workspace.json', '.gitignore', '.mcp.json'].every((rel) => tracked.includes(rel))
    && tracked.every((path) => !path.startsWith('.workspace-update/')));
  report(redirected, failuresBefore);

  // ---- A freshly created, empty repository ----
  failuresBefore = failed;
  const freshRepo = join(base, 'fresh-repo');
  mkdirSync(freshRepo);
  git(freshRepo, ['init']);
  const inRepo = await runCli([
    NAME,
    { ...DIRECTORY, answer: `${freshRepo}\n` },
    NO_REPO,
    USER,
    NO_RULES,
  ], env);

  check('a directory holding only a fresh .git is not refused',
    inRepo.signal === null && inRepo.reached === 5 && inRepo.code === 0 && !inRepo.out.includes('already has files'));
  check('the workspace is reported as created', inRepo.out.includes('Workspace created at'));
  check('the workspace is committed on the repository that was already there',
    gitState(freshRepo, ['rev-list', '--count', 'HEAD']).trim() === '1'
    && gitState(freshRepo, ['ls-files']).includes('.gitignore')
    && gitState(freshRepo, ['status', '--porcelain']).trim() === '');
  report(inRepo, failuresBefore);
} finally {
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
}

if (failed > 0) {
  console.error(`${failed} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} checks passed`);
