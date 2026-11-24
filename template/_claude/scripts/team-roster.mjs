#!/usr/bin/env node
// Read and maintain the team roster (workspace.json → workspace.team, gh:133)
// and the machine-local identity that points into it.
//
// The roster records who the team members are, keyed by their
// workspace-context/team-member/ folder name, and links each name to the
// person's forge login and git emails. workspace.user in
// .claude/settings.local.json stays the per-machine choice; the roster is
// what that choice is checked against. See lib/team-roster.mjs for the
// schema and the checks.
//
// Usage (every command prints one JSON object):
//   node team-roster.mjs --suggest   [--root <dir>] [--offline]
//       The default for the identity prompt: forge login, then git email,
//       then the OS username, each resolved through the roster.
//   node team-roster.mjs --whoami    [--root <dir>] [--offline]
//       Who this machine is, and the `handle` to use in @-attributions.
//   node team-roster.mjs --check     [--root <dir>] [--offline]
//       Roster validity, team-member folders, and this machine's identity.
//       Exits 1 when any finding is issue-severity.
//   node team-roster.mjs --add <key> [--name <n>] [--forge <login>]...
//                                    [--email <e>]... [--alias <a>]...
//                                    [--detect] [--root <dir>] [--offline]
//       Create or extend a roster entry in workspace.json (a tracked change —
//       commit it like any other). --detect also records this machine's
//       forge login and git email. Refuses a result that fails validation.
//   node team-roster.mjs --set-user <name> [--new] [--root <dir>]
//       Point this machine at a roster member: writes workspace.user, repoints
//       CLAUDE.local.md, creates the folder and regenerates the indexes. An
//       alias is refused in favour of its owner; a name outside the roster
//       needs --new.
//   node team-roster.mjs --merge-alias <alias> [--apply] [--root <dir>]
//       Merge team-member/<alias>/ into its owner's folder. Dry run by
//       default. Tracked files move with `git mv` (history follows them),
//       untracked ones (local-only drafts) are renamed, `author: <alias>`
//       frontmatter becomes the owner (in the files moved and in those
//       already in the owner's folder), and the generated index.md is dropped.
//       Any path that already exists in the owner's folder stops the whole
//       merge before anything moves. Nothing is committed.
//
// Exit codes: 0 — done; 1 — refused, or --check found an issue; 2 — bad
// arguments or an unreadable workspace.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  NAME_PATTERN,
  normalizeRoster,
  lookup,
  memberByForge,
  memberByEmail,
  suggestUser,
  attributionHandle,
  identityFindings,
  folderFindings,
  listTeamFolders,
  readGitEmail,
  readForgeLogin,
} from '../lib/team-roster.mjs';
import { renderClaudeLocal, ensurePerUserIndex } from './generate-claude-local.mjs';

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

class UsageError extends Error {}
class Refusal extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

const toPosix = (p) => p.split(sep).join('/');

function readJSON(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Everything the commands share, read once from the workspace root. */
export function loadContext(root) {
  const absRoot = resolve(root);
  const wsPath = join(absRoot, 'workspace.json');
  if (!existsSync(wsPath)) throw new UsageError(`no workspace.json at ${absRoot}`);
  let wsConfig;
  try {
    wsConfig = JSON.parse(readFileSync(wsPath, 'utf8'));
  } catch (err) {
    throw new UsageError(`workspace.json does not parse: ${err.message}`);
  }
  const ws = wsConfig?.workspace && typeof wsConfig.workspace === 'object' ? wsConfig.workspace : {};
  const wcDir = typeof ws.workspaceContextDir === 'string' && ws.workspaceContextDir
    ? ws.workspaceContextDir
    : 'workspace-context';
  const settingsPath = join(absRoot, '.claude', 'settings.local.json');
  let settings = null;
  try {
    settings = readJSON(settingsPath);
  } catch {
    settings = null;
  }
  const user = typeof settings?.workspace?.user === 'string' && settings.workspace.user
    ? settings.workspace.user
    : null;
  return { absRoot, wsPath, wsConfig, ws, wcDir, roster: normalizeRoster(ws.team), settingsPath, settings, user };
}

function osUsername() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || null;
  }
}

// ---------- --suggest / --whoami / --check ----------

export function suggest(ctx, { offline = false, spawnFn = nodeSpawnSync, osUser = osUsername() } = {}) {
  const forgeLogin = offline ? null : readForgeLogin(ctx.ws, { spawnFn });
  const gitEmail = readGitEmail(ctx.absRoot, { spawnFn });
  const s = suggestUser(ctx.roster, { forgeLogin, gitEmail, osUser });
  const aliases = {};
  for (const m of ctx.roster.members) for (const a of m.aliases) aliases[a] = m.key;
  return {
    suggestion: s.user,
    source: s.source,
    current: ctx.user,
    roster: ctx.roster.present,
    members: ctx.roster.members.map((m) => ({ key: m.key, name: m.name })),
    aliases,
    folders: listTeamFolders(ctx.absRoot, ctx.wcDir),
  };
}

export function whoami(ctx, { offline = false, spawnFn = nodeSpawnSync } = {}) {
  const hit = lookup(ctx.roster, ctx.user);
  const member = hit?.member || null;
  // The roster's login answers without the network; only ask the forge when
  // the roster has nothing to say.
  let forgeLogin = null;
  if (!member?.forge.length && !offline) forgeLogin = readForgeLogin(ctx.ws, { spawnFn });
  return {
    user: ctx.user,
    member: member?.key || null,
    via: hit?.via || null,
    name: member?.name || null,
    handle: attributionHandle(ctx.roster, { user: member?.key || ctx.user, forgeLogin }),
    roster: ctx.roster.present,
  };
}

export function check(ctx, { offline = false, spawnFn = nodeSpawnSync } = {}) {
  const forgeLogin = offline ? null : readForgeLogin(ctx.ws, { spawnFn });
  const gitEmail = readGitEmail(ctx.absRoot, { spawnFn });
  const folders = listTeamFolders(ctx.absRoot, ctx.wcDir);
  const findings = [
    ...ctx.roster.problems.map((p) => ({ ...p, code: 'roster', file: 'workspace.json' })),
    ...folderFindings(ctx.roster, folders).map((f) => ({
      ...f,
      file: `${ctx.wcDir}/team-member/${f.folder}/`,
    })),
    ...identityFindings(ctx.roster, { user: ctx.user, forgeLogin, gitEmail }).map((f) => ({
      ...f,
      file: '.claude/settings.local.json',
    })),
  ];
  return {
    roster: ctx.roster.present,
    members: ctx.roster.members.length,
    folders,
    user: ctx.user,
    forgeLogin,
    gitEmail,
    findings,
  };
}

// ---------- --add ----------

function union(existing, added, key = (v) => v) {
  const out = [...existing];
  const seen = new Set(existing.map(key));
  for (const v of added) {
    if (!seen.has(key(v))) {
      out.push(v);
      seen.add(key(v));
    }
  }
  return out;
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const fold = (s) => String(s).trim().toLowerCase();

/**
 * Return a workspace.json object with roster entry `key` created or
 * extended. Lists are unioned (forge and email case-insensitively), so
 * re-running is a no-op. Pure: the caller writes the result.
 */
export function addMember(wsConfig, key, { name, forge = [], emails = [], aliases = [] } = {}) {
  if (!NAME_PATTERN.test(key)) throw new UsageError(`"${key}" is not a valid folder name (letters, digits, - and _ only)`);
  const next = structuredClone(wsConfig);
  next.workspace = next.workspace && typeof next.workspace === 'object' ? next.workspace : {};
  const team = next.workspace.team && typeof next.workspace.team === 'object' && !Array.isArray(next.workspace.team)
    ? next.workspace.team
    : {};
  const entry = { ...(team[key] && typeof team[key] === 'object' ? team[key] : {}) };
  if (name) entry.name = name;
  const forgeList = union(asList(entry.forge), forge, fold);
  if (forgeList.length === 1) entry.forge = forgeList[0];
  else if (forgeList.length > 1) entry.forge = forgeList;
  const emailList = union(asList(entry.gitEmails), emails, fold);
  if (emailList.length) entry.gitEmails = emailList;
  const aliasList = union(asList(entry.aliases), aliases);
  if (aliasList.length) entry.aliases = aliasList;
  team[key] = entry;
  next.workspace.team = team;
  return next;
}

export function add(ctx, key, opts = {}, { offline = false, spawnFn = nodeSpawnSync } = {}) {
  const forge = [...(opts.forge || [])];
  const emails = [...(opts.emails || [])];
  const notes = [];
  if (opts.detect) {
    // A detected identity already given to someone else is a mismatch to
    // report, not a value to copy — recording it would make the roster
    // contradict itself.
    const login = offline ? null : readForgeLogin(ctx.ws, { spawnFn });
    const loginOwner = memberByForge(ctx.roster, login);
    if (login && loginOwner && loginOwner.key !== key) {
      notes.push(`forge login "${login}" belongs to ${loginOwner.key} — not recorded`);
    } else if (login) forge.push(login);
    else notes.push(offline ? 'forge login not looked up (--offline)' : 'no forge login found (CLI missing or signed out)');
    const email = readGitEmail(ctx.absRoot, { spawnFn });
    const emailOwner = memberByEmail(ctx.roster, email);
    if (email && emailOwner && emailOwner.key !== key) {
      notes.push(`git email ${email} belongs to ${emailOwner.key} — not recorded`);
    } else if (email) emails.push(email);
    else notes.push('no git user.email configured');
  }
  const hit = lookup(ctx.roster, key);
  if (hit?.via === 'alias') {
    throw new Refusal(`"${key}" is an alias of ${hit.member.key} — add to that entry instead`);
  }
  const next = addMember(ctx.wsConfig, key, { name: opts.name, forge, emails, aliases: opts.aliases || [] });
  const before = new Set(ctx.roster.problems.filter((p) => p.severity === 'issue').map((p) => p.message));
  const introduced = normalizeRoster(next.workspace.team).problems
    .filter((p) => p.severity === 'issue' && !before.has(p.message));
  if (introduced.length) {
    throw new Refusal('the change would make the roster contradict itself', { problems: introduced.map((p) => p.message) });
  }
  const changed = JSON.stringify(next) !== JSON.stringify(ctx.wsConfig);
  if (changed) writeFileSync(ctx.wsPath, JSON.stringify(next, null, 2) + '\n');
  return { key, entry: next.workspace.team[key], changed, notes };
}

// ---------- --set-user ----------

export function setUser(ctx, name, { allowNew = false } = {}) {
  if (!NAME_PATTERN.test(name)) throw new UsageError(`"${name}" is not a valid folder name (letters, digits, - and _ only)`);
  const hit = lookup(ctx.roster, name);
  if (hit?.via === 'alias') {
    throw new Refusal(`"${name}" is an alias of ${hit.member.key} — run --set-user ${hit.member.key}`);
  }
  if (ctx.roster.present && !hit && !allowNew) {
    throw new Refusal(
      `"${name}" is not in the team roster. Pick a member (${ctx.roster.members.map((m) => m.key).join(', ')}), ` +
      `or pass --new and add yourself with --add ${name} --detect`,
    );
  }
  const previous = ctx.user;
  const settings = ctx.settings && typeof ctx.settings === 'object' ? structuredClone(ctx.settings) : {};
  settings.workspace = settings.workspace && typeof settings.workspace === 'object' ? settings.workspace : {};
  settings.workspace.user = name;
  mkdirSync(dirname(ctx.settingsPath), { recursive: true });
  writeFileSync(ctx.settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // CLAUDE.local.md may carry the person's own additions. Rewrite it only
  // when it is exactly the generated file, or swap just the import line;
  // anything else is left for the person to edit.
  const localPath = join(ctx.absRoot, 'CLAUDE.local.md');
  let claudeLocal;
  if (!existsSync(localPath)) {
    writeFileSync(localPath, renderClaudeLocal(name));
    claudeLocal = 'written';
  } else {
    const current = readFileSync(localPath, 'utf8');
    const oldImport = previous ? `@workspace-context/team-member/${previous}/index.md` : null;
    if (current === renderClaudeLocal(name)) claudeLocal = 'unchanged';
    else if (previous && current === renderClaudeLocal(previous)) {
      writeFileSync(localPath, renderClaudeLocal(name));
      claudeLocal = 'written';
    } else if (oldImport && current.includes(oldImport)) {
      writeFileSync(localPath, current.split(oldImport).join(`@workspace-context/team-member/${name}/index.md`));
      claudeLocal = 'import-updated';
    } else {
      claudeLocal = 'left-alone';
    }
  }
  const folder = join(ctx.absRoot, ctx.wcDir, 'team-member', name);
  const createdFolder = !existsSync(folder);
  mkdirSync(folder, { recursive: true });
  const index = ensurePerUserIndex(ctx.absRoot);
  return { user: name, previous, claudeLocal, createdFolder, index };
}

// ---------- --merge-alias ----------

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function gitLines(root, args, spawnFn) {
  const r = spawnFn('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return String(r.stdout || '').split('\0').map((s) => s.trim()).filter(Boolean);
}

/**
 * Plan the merge of team-member/<alias>/ into its owner's folder without
 * touching anything. Returns { alias, owner, from, to, moves, drop,
 * conflicts, references }; paths are root-relative POSIX.
 */
export function planAliasMerge(ctx, alias, { spawnFn = nodeSpawnSync } = {}) {
  const hit = lookup(ctx.roster, alias);
  if (!hit) {
    throw new Refusal(`"${alias}" is not in the team roster — list it in its owner's aliases first`);
  }
  if (hit.via !== 'alias') {
    throw new Refusal(`"${alias}" is a member, not an alias — declare it in its owner's aliases first`);
  }
  const owner = hit.member.key;
  const tm = `${ctx.wcDir}/team-member`;
  const from = `${tm}/${alias}`;
  const to = `${tm}/${owner}`;
  const fromAbs = join(ctx.absRoot, from);
  const toAbs = join(ctx.absRoot, to);
  const plan = { alias, owner, from, to, moves: [], drop: [], retag: [], conflicts: [], references: [] };

  // Files already in the owner's folder can carry the alias as their
  // author too (written from the alias's machine into the right folder).
  // They are part of the same split, so the merge fixes them as well.
  if (existsSync(toAbs)) {
    for (const abs of walkFiles(toAbs)) {
      if (authorIs(abs, alias)) plan.retag.push(toPosix(relative(ctx.absRoot, abs)));
    }
  }
  if (!existsSync(fromAbs)) return plan;

  const tracked = new Set(gitLines(ctx.absRoot, ['ls-files', '-z', '--', from], spawnFn) || []);
  for (const abs of walkFiles(fromAbs)) {
    const rel = toPosix(relative(ctx.absRoot, abs));
    const inner = toPosix(relative(fromAbs, abs));
    // The per-user index is generated; the owner's is rebuilt after the move.
    if (inner === 'index.md') {
      plan.drop.push({ path: rel, tracked: tracked.has(rel) });
      continue;
    }
    const target = `${to}/${inner}`;
    if (existsSync(join(ctx.absRoot, target))) plan.conflicts.push({ from: rel, to: target });
    else plan.moves.push({ from: rel, to: target, tracked: tracked.has(rel) });
  }

  // Hand-written references to the old folder elsewhere in the tree. The
  // generated catalogs are rebuilt, so they are not listed.
  const generated = new Set([`${ctx.wcDir}/index.md`, `${ctx.wcDir}/canonical.md`]);
  const refs = gitLines(ctx.absRoot, ['grep', '-z', '-l', '-F', `team-member/${alias}/`], spawnFn) || [];
  plan.references = refs
    .filter((p) => !p.startsWith(`${from}/`) && !generated.has(p) && !/\/team-member\/[^/]+\/index\.md$/.test(p));
  return plan;
}

// `author:` in a markdown file's frontmatter, and only there: a body line
// that happens to start with "author:" is content, not metadata.
const authorLine = (name) => new RegExp(`^(author:[ \\t]*["']?)${name}(["']?[ \\t]*)$`, 'm');

function frontmatter(text) {
  return text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
}

function authorIs(absPath, name) {
  if (!absPath.endsWith('.md')) return false;
  const m = frontmatter(readFileSync(absPath, 'utf8'));
  return Boolean(m && authorLine(name).test(m[1]));
}

function rewriteAuthor(absPath, alias, owner) {
  if (!authorIs(absPath, alias)) return false;
  const text = readFileSync(absPath, 'utf8');
  const m = frontmatter(text);
  const fm = m[1].replace(authorLine(alias), `$1${owner}$2`);
  writeFileSync(absPath, text.slice(0, m.index) + m[0].replace(m[1], fm) + text.slice(m.index + m[0].length));
  return true;
}

function removeEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) removeEmptyDirs(p);
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

export function applyAliasMerge(ctx, plan, { spawnFn = nodeSpawnSync } = {}) {
  if (plan.conflicts.length) {
    throw new Refusal(
      `${plan.conflicts.length} path(s) already exist in ${plan.to}/ — rename or remove one copy, then re-run`,
      { conflicts: plan.conflicts },
    );
  }
  const git = (args) => {
    const r = spawnFn('git', ['-C', ctx.absRoot, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr || '').trim()}`);
  };
  let authors = 0;
  for (const move of plan.moves) {
    const dst = join(ctx.absRoot, move.to);
    mkdirSync(dirname(dst), { recursive: true });
    if (move.tracked) git(['mv', '--', move.from, move.to]);
    else renameSync(join(ctx.absRoot, move.from), dst);
    if (rewriteAuthor(dst, plan.alias, plan.owner)) authors++;
  }
  for (const rel of plan.retag) {
    if (rewriteAuthor(join(ctx.absRoot, rel), plan.alias, plan.owner)) authors++;
  }
  for (const d of plan.drop) {
    if (d.tracked) git(['rm', '-q', '--', d.path]);
    else if (existsSync(join(ctx.absRoot, d.path))) unlinkSync(join(ctx.absRoot, d.path));
  }
  removeEmptyDirs(join(ctx.absRoot, plan.from));
  const index = ensurePerUserIndex(ctx.absRoot);
  return {
    moved: plan.moves.length,
    tracked: plan.moves.filter((m) => m.tracked).length,
    authorsRewritten: authors,
    dropped: plan.drop.length,
    folderRemoved: !existsSync(join(ctx.absRoot, plan.from)),
    index,
  };
}

// ---------- CLI ----------

const COMMANDS = ['--suggest', '--whoami', '--check', '--add', '--set-user', '--merge-alias'];

export function parseArgs(argv) {
  const args = { root: process.cwd(), offline: false, apply: false, detect: false, allowNew: false, forge: [], emails: [], aliases: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (COMMANDS.includes(a)) {
      if (args.command) throw new UsageError(`pick one of ${COMMANDS.join(', ')}`);
      args.command = a.slice(2);
      if (['add', 'set-user', 'merge-alias'].includes(args.command)) args.target = value();
    } else if (a === '--root') args.root = value();
    else if (a === '--offline') args.offline = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--detect') args.detect = true;
    else if (a === '--new') args.allowNew = true;
    else if (a === '--name') args.name = value();
    else if (a === '--forge') args.forge.push(value());
    else if (a === '--email') args.emails.push(value());
    else if (a === '--alias') args.aliases.push(value());
    else throw new UsageError(`unknown argument: ${a}`);
  }
  if (!args.command) throw new UsageError(`pick one of ${COMMANDS.join(', ')}`);
  return args;
}

export function run(argv, { spawnFn = nodeSpawnSync, osUser } = {}) {
  const args = parseArgs(argv);
  const ctx = loadContext(args.root);
  const io = { offline: args.offline, spawnFn };
  switch (args.command) {
    case 'suggest':
      return { out: suggest(ctx, { ...io, ...(osUser !== undefined ? { osUser } : {}) }), code: 0 };
    case 'whoami':
      return { out: whoami(ctx, io), code: 0 };
    case 'check': {
      const out = check(ctx, io);
      return { out, code: out.findings.some((f) => f.severity === 'issue') ? 1 : 0 };
    }
    case 'add':
      return {
        out: add(ctx, args.target, { name: args.name, forge: args.forge, emails: args.emails, aliases: args.aliases, detect: args.detect }, io),
        code: 0,
      };
    case 'set-user':
      return { out: setUser(ctx, args.target, { allowNew: args.allowNew }), code: 0 };
    case 'merge-alias': {
      const plan = planAliasMerge(ctx, args.target, io);
      if (!args.apply) return { out: { dryRun: true, ...plan }, code: plan.conflicts.length ? 1 : 0 };
      return { out: { dryRun: false, ...plan, result: applyAliasMerge(ctx, plan, io) }, code: 0 };
    }
    default:
      throw new UsageError(`unknown command ${args.command}`);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const { out, code } = run(process.argv.slice(2));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(code);
  } catch (err) {
    if (err instanceof Refusal) {
      process.stdout.write(JSON.stringify({ refused: err.message, ...err.details }, null, 2) + '\n');
      process.exit(1);
    }
    process.stderr.write(`team-roster: ${err.message}\n`);
    process.exit(2);
  }
}
