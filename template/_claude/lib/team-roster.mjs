// The team roster: who the people in this workspace are, read from
// workspace.json → workspace.team (gh:133).
//
// A person's identity used to be only the free-text workspace.user in their
// machine-local settings. Nothing tracked said who the team was, and nothing
// tied that name to the person's git author or forge login — so a teammate
// whose OS username differed from the folder a colleague made for them
// quietly got a second team-member/ folder, and nothing noticed.
//
// The roster is keyed by team-member/ folder name:
//
//   "team": {
//     "alex": {
//       "name": "Alex Example",          // display name
//       "forge": "alex-example",         // login, or a list of logins
//       "gitEmails": ["alex@example.com"],
//       "aliases": ["alexw"]             // other names that mean this person
//     }
//   }
//
// Every field is optional. An absent or empty roster turns every check off:
// a workspace without one behaves exactly as it did before. The roster adds
// checks; it never gates anything.
//
// This module is pure apart from the three small readers at the bottom
// (team-member folders, git email, forge login), which take injectable
// spawn functions so tests never shell out.

import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';

export const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const ENTRY_FIELDS = new Set(['name', 'forge', 'gitEmails', 'aliases']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stringList(value) {
  if (value === undefined || value === null) return { list: [], ok: true };
  if (typeof value === 'string') return { list: value ? [value] : [], ok: true };
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return { list: value.filter(Boolean), ok: true };
  }
  return { list: [], ok: false };
}

const fold = (s) => String(s).trim().toLowerCase();

/**
 * Normalize and validate workspace.team.
 *
 * Returns { present, members, problems }:
 *   present  — the roster is a non-empty object; when false, no check runs
 *   members  — [{ key, name, forge[], gitEmails[], aliases[] }]
 *   problems — [{ severity: 'issue'|'warning', message }]
 *
 * Issues are contradictions the checks cannot work around (a bad key, a
 * login or email given to two people, an alias that collides). Warnings are
 * fields that were ignored. A member with a problem field is still listed,
 * minus that field, so one typo doesn't switch the whole roster off.
 */
export function normalizeRoster(team) {
  const result = { present: false, members: [], problems: [] };
  if (team === undefined || team === null) return result;
  if (!isPlainObject(team)) {
    result.problems.push({
      severity: 'issue',
      message: 'workspace.team must be an object keyed by team-member folder name',
    });
    return result;
  }
  const keys = Object.keys(team);
  if (keys.length === 0) return result;
  result.present = true;

  const issue = (message) => result.problems.push({ severity: 'issue', message });
  const warn = (message) => result.problems.push({ severity: 'warning', message });

  for (const key of keys) {
    if (!NAME_PATTERN.test(key)) {
      issue(`team member "${key}" is not a valid folder name (letters, digits, - and _ only)`);
      continue;
    }
    const entry = team[key] ?? {};
    if (!isPlainObject(entry)) {
      issue(`team.${key} must be an object (use {} for a member with nothing to record)`);
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(field)) {
        warn(`team.${key} has unknown field "${field}" (expected name, forge, gitEmails, aliases)`);
      }
    }
    let name = null;
    if (entry.name !== undefined) {
      if (typeof entry.name === 'string' && entry.name.trim()) name = entry.name.trim();
      else warn(`team.${key}.name must be a non-empty string — ignored`);
    }
    const forge = stringList(entry.forge);
    if (!forge.ok) warn(`team.${key}.forge must be a login or a list of logins — ignored`);
    const emails = stringList(entry.gitEmails);
    if (!emails.ok) warn(`team.${key}.gitEmails must be a list of email addresses — ignored`);
    const aliases = stringList(entry.aliases);
    if (!aliases.ok) warn(`team.${key}.aliases must be a list of names — ignored`);
    const validAliases = [];
    for (const alias of aliases.list) {
      if (!NAME_PATTERN.test(alias)) issue(`team.${key} alias "${alias}" is not a valid folder name`);
      else if (alias === key) warn(`team.${key} lists itself as an alias — ignored`);
      else if (fold(alias) === fold(key)) issue(`team.${key} alias "${alias}" differs from it only in case — one folder on macOS and Windows`);
      else validAliases.push(alias);
    }
    result.members.push({
      key,
      name,
      forge: forge.list.map((l) => l.trim()).filter(Boolean),
      gitEmails: emails.list.map((e) => e.trim()).filter(Boolean),
      aliases: validAliases,
    });
  }

  // Cross-member contradictions: one name, login or email meaning two people.
  // Names compare case-insensitively: on macOS and Windows, team-member/Alex
  // and team-member/alex are the same folder.
  const memberKeys = new Set(result.members.map((m) => fold(m.key)));
  const claimed = (label, valueOf, normalize = (v) => v) => {
    const owners = new Map();
    for (const m of result.members) {
      for (const v of valueOf(m)) {
        const k = normalize(v);
        if (!owners.has(k)) owners.set(k, new Set());
        owners.get(k).add(m.key);
      }
    }
    for (const [value, who] of owners) {
      if (who.size > 1) issue(`${label} "${value}" is given to more than one member: ${[...who].join(', ')}`);
    }
  };
  for (const m of result.members) {
    for (const alias of m.aliases) {
      if (fold(alias) !== fold(m.key) && memberKeys.has(fold(alias))) issue(`team.${m.key} alias "${alias}" is also a member's name`);
    }
  }
  claimed('member name', (m) => [m.key], fold);
  claimed('alias', (m) => m.aliases, fold);
  claimed('forge login', (m) => m.forge, fold);
  claimed('git email', (m) => m.gitEmails, fold);
  return result;
}

/** Resolve a name through the roster: { member, via: 'key'|'alias' } or null. */
export function lookup(roster, name) {
  if (!roster?.present || !name) return null;
  const byKey = roster.members.find((m) => m.key === name);
  if (byKey) return { member: byKey, via: 'key' };
  const byAlias = roster.members.find((m) => m.aliases.includes(name));
  if (byAlias) return { member: byAlias, via: 'alias' };
  return null;
}

export function memberByForge(roster, login) {
  if (!roster?.present || !login) return null;
  return roster.members.find((m) => m.forge.some((l) => fold(l) === fold(login))) || null;
}

export function memberByEmail(roster, email) {
  if (!roster?.present || !email) return null;
  return roster.members.find((m) => m.gitEmails.some((e) => fold(e) === fold(email))) || null;
}

/** Turn an OS username into something NAME_PATTERN accepts. */
export function sanitizeName(raw) {
  const cleaned = String(raw || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || null;
}

/**
 * The default for the identity prompt. The roster is consulted first — the
 * forge login, then the git email — and only when neither matches does the
 * OS username stand in, resolved through the aliases (an OS username that is
 * a declared alias suggests its owner).
 *
 * Returns { user, source, member } where source is 'forge', 'git-email',
 * 'os-alias', 'os' or null.
 */
export function suggestUser(roster, { forgeLogin = null, gitEmail = null, osUser = null } = {}) {
  const byForge = memberByForge(roster, forgeLogin);
  if (byForge) return { user: byForge.key, source: 'forge', member: byForge };
  const byEmail = memberByEmail(roster, gitEmail);
  if (byEmail) return { user: byEmail.key, source: 'git-email', member: byEmail };
  const os = sanitizeName(osUser);
  if (!os) return { user: null, source: null, member: null };
  const hit = lookup(roster, os);
  if (hit?.via === 'alias') return { user: hit.member.key, source: 'os-alias', member: hit.member };
  return { user: os, source: 'os', member: hit?.member || null };
}

/** The @-mention handle for this person: the roster's login, else the live one, else the name. */
export function attributionHandle(roster, { user = null, forgeLogin = null } = {}) {
  const hit = lookup(roster, user);
  if (hit?.member.forge.length) return hit.member.forge[0];
  return forgeLogin || user || null;
}

const SCRIPT = 'node .claude/scripts/team-roster.mjs';

/**
 * Findings about this machine's identity: workspace.user against the roster,
 * and the git email / forge login against what the roster says about them.
 * Each finding is { severity, code, message }. Nothing is reported without a
 * roster, or without a workspace.user (session-start's setup hint covers that).
 *
 * forgeLogin and gitEmail are optional — pass only what was cheap to read.
 * session-start passes the git email alone (no network); /maintenance adds
 * the forge login.
 */
export function identityFindings(roster, { user = null, forgeLogin = null, gitEmail = null } = {}) {
  const findings = [];
  if (!roster?.present || !user) return findings;
  const hit = lookup(roster, user);
  let effective = null;
  if (!hit) {
    findings.push({
      severity: 'warning',
      code: 'user-unknown',
      message:
        `workspace.user "${user}" is not in the team roster (workspace.team). ` +
        `If you already have an entry, switch to it: ${SCRIPT} --set-user <name> --root . — ` +
        `if you are new, add yourself in your next change: ${SCRIPT} --add ${user} --detect --root .`,
    });
  } else if (hit.via === 'alias') {
    effective = hit.member;
    findings.push({
      severity: 'warning',
      code: 'user-alias',
      message:
        `workspace.user "${user}" is an alias of "${hit.member.key}" in the team roster, so your ` +
        `context loads from the wrong folder. Switch: ${SCRIPT} --set-user ${hit.member.key} --root .`,
    });
  } else {
    effective = hit.member;
  }

  const describe = (m) => (m.name ? `${m.key} (${m.name})` : m.key);
  const forgeOwner = memberByForge(roster, forgeLogin);
  if (forgeOwner && forgeOwner !== effective) {
    findings.push({
      severity: 'warning',
      code: 'forge-mismatch',
      message:
        `this machine is signed in to the forge as "${forgeLogin}", which the roster gives to ` +
        `${describe(forgeOwner)}, but workspace.user is "${user}"`,
    });
  }
  const emailOwner = memberByEmail(roster, gitEmail);
  if (emailOwner && emailOwner !== effective) {
    findings.push({
      severity: 'warning',
      code: 'email-mismatch',
      message:
        `git commits here as ${gitEmail}, which the roster gives to ${describe(emailOwner)}, ` +
        `but workspace.user is "${user}"`,
    });
  }
  if (effective && forgeLogin && !forgeOwner) {
    findings.push({
      severity: 'info',
      code: 'forge-unrecorded',
      message:
        `forge login "${forgeLogin}" is not in ${effective.key}'s roster entry — record it: ` +
        `${SCRIPT} --add ${effective.key} --forge ${forgeLogin} --root .`,
    });
  }
  // An email nobody claims means one of two things. If the member has
  // recorded emails, the likelier story is a mistyped or wrong-machine
  // config — commits would land under an address that isn't theirs — so it
  // is a warning that leads with the fix. If they have recorded none, the
  // roster simply hasn't been told yet, and recording it is the suggestion.
  if (effective && gitEmail && !emailOwner && effective.gitEmails.length) {
    findings.push({
      severity: 'warning',
      code: 'email-unknown',
      message:
        `git commits here as ${gitEmail}, which isn't one of ${effective.key}'s emails ` +
        `(${effective.gitEmails.join(', ')}). If that's a mistake: ` +
        `git config user.email ${effective.gitEmails[0]} — if it's a new address of yours: ` +
        `${SCRIPT} --add ${effective.key} --email ${gitEmail} --root .`,
    });
  } else if (effective && gitEmail && !emailOwner) {
    findings.push({
      severity: 'info',
      code: 'email-unrecorded',
      message:
        `git email ${gitEmail} is not in ${effective.key}'s roster entry yet — record it: ` +
        `${SCRIPT} --add ${effective.key} --email ${gitEmail} --root .`,
    });
  }
  return findings;
}

/**
 * The lines session-start prints: the identity warnings that local facts
 * alone can establish (no forge login — that needs the network, so
 * /maintenance checks it). Infos are left to /maintenance too; a session
 * start is not the place for "you could record this email".
 */
export function sessionStartLines(roster, { user = null, gitEmail = null } = {}) {
  return identityFindings(roster, { user, gitEmail })
    .filter((f) => f.severity === 'warning')
    // No closing period: several messages end in a command to copy.
    .map((f) => `Team identity: ${f.message}`);
}

/**
 * Findings about the team-member/ folders against the roster: a folder that
 * is a declared alias (a split to merge), and a folder nobody claims (an
 * orphan, or a duplicate not yet declared). A member with no folder is fine
 * — the folder is created at their first capture.
 *
 * Returns [{ severity, code, folder, message }].
 */
export function folderFindings(roster, folders = []) {
  const findings = [];
  if (!roster?.present) return findings;
  for (const folder of folders) {
    const hit = lookup(roster, folder);
    if (hit?.via === 'key') continue;
    if (hit?.via === 'alias') {
      findings.push({
        severity: 'warning',
        code: 'alias-folder',
        folder,
        message:
          `belongs to ${hit.member.key} ("${folder}" is an alias) — merge it into ` +
          `team-member/${hit.member.key}/: ${SCRIPT} --merge-alias ${folder} --root .`,
      });
      continue;
    }
    findings.push({
      severity: 'warning',
      code: 'orphan-folder',
      folder,
      message:
        `has no team roster entry — add "${folder}" to workspace.team, or list it in its ` +
        `owner's aliases so /maintenance can merge it`,
    });
  }
  return findings;
}

// ---------- readers (best effort, never throw) ----------

/**
 * Folders under {wcDir}/team-member/ that hold at least one file. Git does
 * not track empty directories, so an empty one is local leftovers, not a
 * teammate's context. lstat throughout: a symlink is content, never a
 * directory to descend into, so a link loop cannot hang the audit.
 */
export function listTeamFolders(root, wcDir = 'workspace-context') {
  const dir = join(root, wcDir, 'team-member');
  if (!existsSync(dir)) return [];
  const hasFile = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = lstatSync(p);
      if (!st.isDirectory() || hasFile(p)) return true;
    }
    return false;
  };
  return readdirSync(dir)
    .filter((name) => {
      const p = join(dir, name);
      try {
        return lstatSync(p).isDirectory() && hasFile(p);
      } catch {
        return false;
      }
    })
    .sort();
}

/** `git config user.email` as seen from root, or null. */
export function readGitEmail(root, { spawnFn = nodeSpawnSync } = {}) {
  try {
    const r = spawnFn('git', ['-C', root, 'config', '--get', 'user.email'], { encoding: 'utf8', timeout: 3000 });
    const v = r.status === 0 ? String(r.stdout || '').trim() : '';
    return v || null;
  } catch {
    return null;
  }
}

/**
 * The login this machine's forge CLI is signed in as, or null when the CLI
 * is missing, signed out, offline or slow. GitLab when workspace.forge.type
 * is "gitlab" (against workspace.forge.host, default gitlab.com), GitHub
 * otherwise; workspace.forge === false means no forge.
 */
export function readForgeLogin(ws = {}, { spawnFn = nodeSpawnSync, timeoutMs = 5000 } = {}) {
  const forge = ws?.forge;
  if (forge === false) return null;
  try {
    if (forge?.type === 'gitlab') {
      const host = typeof forge.host === 'string' && forge.host ? forge.host : 'gitlab.com';
      const r = spawnFn('glab', ['api', 'user', '--hostname', host], {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env, GITLAB_HOST: host },
      });
      if (r.status !== 0) return null;
      const login = JSON.parse(String(r.stdout || '{}')).username;
      return typeof login === 'string' && login ? login : null;
    }
    const r = spawnFn('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: timeoutMs });
    const v = r.status === 0 ? String(r.stdout || '').trim() : '';
    return v || null;
  } catch {
    return null;
  }
}
