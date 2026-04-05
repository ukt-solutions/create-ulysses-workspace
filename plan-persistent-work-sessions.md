# Persistent Work Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make work sessions persistent, named entities that span multiple Claude Code chats with cross-chat continuity, parallel session support via workspace worktrees, and unified PR workflows.

**Architecture:** Session markers in `.claude-scratchpad/` are the single source of truth for work session state. Hooks read/write markers. Helper scripts handle worktree creation/cleanup. Skills orchestrate the user-facing flows. Each work session gets a workspace worktree + project worktree, enabling parallel sessions in separate terminals.

**Tech Stack:** Node.js (ESM) for hooks and helper scripts, Markdown for skills and rules. No new dependencies.

**Worktree:** `repos/create-claude-workspace___wt-persistent-work-sessions/`

**Key implementation detail:** When Claude Code runs from a workspace worktree, hooks resolve the workspace root to the worktree (not the main root). An `.active-session.json` pointer file in each worktree's `.claude-scratchpad/` links back to the main root so hooks can find session markers.

---

### Task 1: Session marker utilities in _utils.mjs

Add functions for reading, writing, and querying session markers. All other tasks depend on these.

**Files:**
- Modify: `template/.claude/hooks/_utils.mjs`

- [ ] **Step 1: Add session marker functions**

Add these functions to the end of `template/.claude/hooks/_utils.mjs`:

```javascript
import { writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
```

Note: `readFileSync` and `existsSync` are already imported. Add the missing ones to the existing import statement at line 1.

Then add these functions after the existing `respond()` function:

```javascript
export function getSessionMarkers(root) {
  const scratchpad = join(root, '.claude-scratchpad');
  if (!existsSync(scratchpad)) return [];
  return readdirSync(scratchpad)
    .filter(f => f.startsWith('.work-session-') && f.endsWith('.json'))
    .map(f => {
      const data = readJSON(join(scratchpad, f));
      return data ? { ...data, _file: f } : null;
    })
    .filter(Boolean);
}

export function readSessionMarker(root, sessionName) {
  return readJSON(join(root, '.claude-scratchpad', `.work-session-${sessionName}.json`));
}

export function writeSessionMarker(root, sessionName, data) {
  const scratchpad = join(root, '.claude-scratchpad');
  if (!existsSync(scratchpad)) mkdirSync(scratchpad, { recursive: true });
  writeFileSync(
    join(scratchpad, `.work-session-${sessionName}.json`),
    JSON.stringify(data, null, 2) + '\n'
  );
}

export function deleteSessionMarker(root, sessionName) {
  const file = join(root, '.claude-scratchpad', `.work-session-${sessionName}.json`);
  if (existsSync(file)) unlinkSync(file);
}

export function getActiveSessionPointer(root) {
  return readJSON(join(root, '.claude-scratchpad', '.active-session.json'));
}

export function getMainRoot(root) {
  const pointer = getActiveSessionPointer(root);
  return pointer?.rootPath || root;
}

export function timeAgo(isoString) {
  if (!isoString) return 'unknown';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

- [ ] **Step 2: Verify the file is syntactically valid**

```bash
cd repos/create-claude-workspace___wt-persistent-work-sessions
node -c template/.claude/hooks/_utils.mjs
```

Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add template/.claude/hooks/_utils.mjs
git commit -m "feat: add session marker utilities to _utils.mjs"
```

---

### Task 2: create-work-session.mjs helper script

Creates both worktrees (workspace + project), symlinks, session marker, active-session pointer, and inflight tracker in a single invocation.

**Files:**
- Create: `template/.claude/scripts/create-work-session.mjs`

- [ ] **Step 1: Create the scripts directory and write the script**

```javascript
#!/usr/bin/env node
// Helper: create workspace + project worktrees, marker, pointer, and inflight tracker
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { getWorkspaceRoot, readJSON, writeSessionMarker } from '../hooks/_utils.mjs';

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
};

const sessionName = getArg('session-name');
const branch = getArg('branch');
const repo = getArg('repo');
const user = getArg('user');
const description = getArg('description') || '';

if (!sessionName || !branch || !repo || !user) {
  console.error('Usage: create-work-session.mjs --session-name NAME --branch BRANCH --repo REPO --user USER [--description DESC]');
  process.exit(1);
}

const root = getWorkspaceRoot(import.meta.url);
const config = readJSON(join(root, 'workspace.json'));
const repoBranch = config?.repos?.[repo]?.branch || 'main';
const reposDir = join(root, 'repos');
const repoDir = join(reposDir, repo);

const wsWorktreeName = `${sessionName}___wt-workspace`;
const projWorktreeName = `${sessionName}___wt-${repo}`;
const wsWorktree = join(reposDir, wsWorktreeName);
const projWorktree = join(reposDir, projWorktreeName);

try {
  // Create workspace branch and worktree
  execSync(`git branch "${branch}" main`, { cwd: root, stdio: 'pipe' });
  execSync(`git worktree add "${wsWorktree}" "${branch}"`, { cwd: root, stdio: 'pipe' });

  // Create project branch and worktree
  execSync(`git fetch origin`, { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
  execSync(`git branch "${branch}" "origin/${repoBranch}"`, { cwd: repoDir, stdio: 'pipe' });
  execSync(`git worktree add "${projWorktree}" "${branch}"`, { cwd: repoDir, stdio: 'pipe' });

  // Symlink repos/ into workspace worktree
  const reposLink = join(wsWorktree, 'repos');
  if (!existsSync(reposLink)) {
    symlinkSync(resolve(reposDir), reposLink);
  }

  // Copy settings.local.json into worktree if it exists
  const settingsSrc = join(root, '.claude', 'settings.local.json');
  const settingsDst = join(wsWorktree, '.claude', 'settings.local.json');
  if (existsSync(settingsSrc)) {
    copyFileSync(settingsSrc, settingsDst);
  }

  // Create .claude-scratchpad in worktree with active-session pointer
  const wsScratchpad = join(wsWorktree, '.claude-scratchpad');
  mkdirSync(wsScratchpad, { recursive: true });
  writeFileSync(
    join(wsScratchpad, '.active-session.json'),
    JSON.stringify({ name: sessionName, rootPath: root }, null, 2) + '\n'
  );

  // Create inflight directory and tracker in workspace worktree
  const inflightDir = join(wsWorktree, 'shared-context', user, 'inflight');
  mkdirSync(inflightDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(inflightDir, `session-${sessionName}.md`),
    `---\nstate: ephemeral\nlifecycle: active\ntype: tracker\ntopic: session-${sessionName}\nbranch: ${branch}\nrepo: ${repo}\nauthor: ${user}\nupdated: ${today}\n---\n\n# Work Session: ${sessionName}\n\n${description}\n\n## Progress\n\n(Updated as the session progresses)\n`
  );

  // Write session marker to main root's scratchpad
  writeSessionMarker(root, sessionName, {
    name: sessionName,
    description,
    branch,
    repo,
    status: 'active',
    created: new Date().toISOString(),
    user,
    chatSessions: [],
  });

  // Output result as JSON for the calling skill
  console.log(JSON.stringify({
    success: true,
    wsWorktree: `repos/${wsWorktreeName}`,
    projWorktree: `repos/${projWorktreeName}`,
    marker: `.claude-scratchpad/.work-session-${sessionName}.json`,
    tracker: `shared-context/${user}/inflight/session-${sessionName}.md`,
  }));
} catch (err) {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
}
```

- [ ] **Step 2: Verify syntax**

```bash
node -c template/.claude/scripts/create-work-session.mjs
```

- [ ] **Step 3: Commit**

```bash
git add template/.claude/scripts/create-work-session.mjs
git commit -m "feat: add create-work-session helper script"
```

---

### Task 3: cleanup-work-session.mjs helper script

Removes both worktrees, deletes local branches, and removes the session marker.

**Files:**
- Create: `template/.claude/scripts/cleanup-work-session.mjs`

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
// Helper: remove workspace + project worktrees, branches, and session marker
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot, readSessionMarker, deleteSessionMarker } from '../hooks/_utils.mjs';

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
};

const sessionName = getArg('session-name');

if (!sessionName) {
  console.error('Usage: cleanup-work-session.mjs --session-name NAME');
  process.exit(1);
}

const root = getWorkspaceRoot(import.meta.url);
const marker = readSessionMarker(root, sessionName);
const repo = marker?.repo;
const branch = marker?.branch;
const reposDir = join(root, 'repos');

const wsWorktreeName = `${sessionName}___wt-workspace`;
const wsWorktree = join(reposDir, wsWorktreeName);
const removed = [];
const errors = [];

// Remove workspace worktree
if (existsSync(wsWorktree)) {
  try {
    execSync(`git worktree remove "${wsWorktree}" --force`, { cwd: root, stdio: 'pipe' });
    removed.push(wsWorktreeName);
  } catch (err) {
    errors.push(`Failed to remove workspace worktree: ${err.message}`);
  }
}

// Remove project worktree
if (repo) {
  const projWorktreeName = `${sessionName}___wt-${repo}`;
  const projWorktree = join(reposDir, projWorktreeName);
  const repoDir = join(reposDir, repo);
  if (existsSync(projWorktree)) {
    try {
      execSync(`git worktree remove "${projWorktree}" --force`, { cwd: repoDir, stdio: 'pipe' });
      removed.push(projWorktreeName);
    } catch (err) {
      errors.push(`Failed to remove project worktree: ${err.message}`);
    }
  }

  // Delete project branch
  if (branch) {
    try {
      execSync(`git branch -d "${branch}"`, { cwd: repoDir, stdio: 'pipe' });
    } catch {
      // Branch may already be deleted or not fully merged — not fatal
    }
  }
}

// Delete workspace branch
if (branch) {
  try {
    execSync(`git branch -d "${branch}"`, { cwd: root, stdio: 'pipe' });
  } catch {
    // Branch may already be deleted — not fatal
  }
}

// Delete session marker
deleteSessionMarker(root, sessionName);

console.log(JSON.stringify({
  success: errors.length === 0,
  removed,
  errors: errors.length > 0 ? errors : undefined,
}));
```

- [ ] **Step 2: Verify syntax**

```bash
node -c template/.claude/scripts/cleanup-work-session.mjs
```

- [ ] **Step 3: Commit**

```bash
git add template/.claude/scripts/cleanup-work-session.mjs
git commit -m "feat: add cleanup-work-session helper script"
```

---

### Task 4: Enhance session-start.mjs

Rewrite to read session markers and present active work sessions prominently.

**Files:**
- Modify: `template/.claude/hooks/session-start.mjs`

- [ ] **Step 1: Rewrite session-start.mjs**

Replace the entire file content with:

```javascript
#!/usr/bin/env node
// SessionStart hook — surface active work sessions and shared context
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, basename, relative } from 'path';
import { execSync } from 'child_process';
import { getWorkspaceRoot, readJSON, respond, getSessionMarkers, getActiveSessionPointer, timeAgo } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const config = readJSON(join(root, 'workspace.json'));
const contextDir = join(root, 'shared-context');
const reposDir = join(root, 'repos');
const lines = [];

if (!config) {
  respond('No workspace.json found. Run /setup to initialize this workspace.');
  process.exit(0);
}

lines.push(`Workspace: ${config.workspace?.name || 'unnamed'}`);

// Check if we're in a workspace worktree
const pointer = getActiveSessionPointer(root);
if (pointer) {
  lines.push(`Active work session: ${pointer.name}`);
  lines.push(`Working in workspace worktree. Main root: ${pointer.rootPath}`);
  respond(lines.join('\n'));
  process.exit(0);
}

// We're at the main workspace root — surface work sessions and context

// Sync repos
const repoNames = Object.keys(config.repos || {});
const missing = [];
const existing = [];

for (const name of repoNames) {
  const repoPath = join(reposDir, name);
  if (existsSync(repoPath)) {
    existing.push(name);
    try {
      execSync('git fetch --quiet', { cwd: repoPath, stdio: 'pipe', timeout: 10000 });
    } catch {}
  } else {
    missing.push(name);
  }
}

if (missing.length > 0) lines.push(`Missing repos: ${missing.join(', ')}. Run /setup to clone them.`);
if (existing.length > 0) lines.push(`Repos synced: ${existing.join(', ')}`);

// Surface active work sessions
const markers = getSessionMarkers(root);
if (markers.length > 0) {
  lines.push('');
  lines.push('Active work sessions:');

  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const wsWorktree = join(reposDir, `${m.name}___wt-workspace`);
    const worktreeExists = existsSync(wsWorktree);

    if (!worktreeExists) {
      lines.push(`  ${i + 1}. ${m.name} (orphaned — worktree missing)`);
      continue;
    }

    const lastChat = m.chatSessions?.[m.chatSessions.length - 1];
    const lastEnded = lastChat?.ended;
    const statusDetail = m.status === 'paused'
      ? `paused ${timeAgo(lastEnded)}`
      : lastEnded
        ? `active, last chat ended ${timeAgo(lastEnded)}`
        : 'active';

    lines.push(`  ${i + 1}. ${m.name} (${statusDetail})`);
    lines.push(`     "${m.description}"`);
    lines.push(`     Branch: ${m.branch} | Repo: ${m.repo}`);
    lines.push(`     Worktree: repos/${m.name}___wt-workspace/`);
    lines.push('');
  }

  lines.push('Use /start-work to resume a session or start new work.');
}

// Surface shared context (secondary)
if (existsSync(contextDir)) {
  const entries = [];

  function scanDir(dir, depth = 0) {
    if (depth > 3) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry === 'locked' || entry === '.keep') continue;
        scanDir(fullPath, depth + 1);
      } else if (entry.endsWith('.md') && entry !== '.keep' && !entry.startsWith('local-only-')) {
        const relPath = relative(contextDir, fullPath);
        if (relPath.startsWith('locked/')) continue;

        const content = readFileSync(fullPath, 'utf-8');
        const topicMatch = content.match(/^topic:\s*(.+)$/m);
        const lifecycleMatch = content.match(/^lifecycle:\s*(.+)$/m);
        const topic = topicMatch ? topicMatch[1].trim() : basename(entry, '.md');
        const lifecycle = lifecycleMatch ? lifecycleMatch[1].trim() : 'active';
        const mtime = stat.mtime.toISOString().slice(0, 16).replace('T', ' ');

        entries.push(`- ${topic} (${lifecycle}, updated ${mtime}) — ${relPath}`);
      }
    }
  }

  scanDir(contextDir);

  if (entries.length > 0) {
    lines.push('');
    lines.push('Shared context:');
    lines.push(...entries);
  }
}

respond(lines.join('\n'));
```

- [ ] **Step 2: Verify syntax**

```bash
node -c template/.claude/hooks/session-start.mjs
```

- [ ] **Step 3: Commit**

```bash
git add template/.claude/hooks/session-start.mjs
git commit -m "feat: session-start hook surfaces active work sessions"
```

---

### Task 5: Enhance session-end.mjs

Update session markers on chat exit and write a safety-net entry to the inflight tracker.

**Files:**
- Modify: `template/.claude/hooks/session-end.mjs`

- [ ] **Step 1: Rewrite session-end.mjs**

Replace the entire file content with:

```javascript
#!/usr/bin/env node
// SessionEnd hook — update session marker, write safety-net to inflight tracker
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getWorkspaceRoot, readStdin, readJSON, respond, getActiveSessionPointer, getMainRoot, readSessionMarker, writeSessionMarker } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const mainRoot = getMainRoot(root);
const scratchpad = join(mainRoot, '.claude-scratchpad');
const logFile = join(scratchpad, 'session-log.jsonl');
const settings = readJSON(join(root, '.claude', 'settings.local.json'));

const input = await readStdin();
const reason = input.reason || 'unknown';
const sessionId = input.session_id || null;
const user = settings?.workspace?.user || 'unknown';

let branch = 'unknown';
try {
  branch = execSync('git branch --show-current', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {}

// Update session marker — mark this chat as ended
const pointer = getActiveSessionPointer(root);
if (pointer) {
  const marker = readSessionMarker(mainRoot, pointer.name);
  if (marker && sessionId) {
    const chatEntry = marker.chatSessions?.find(c => c.id === sessionId && c.ended === null);
    if (chatEntry) {
      chatEntry.ended = new Date().toISOString();
      writeSessionMarker(mainRoot, pointer.name, marker);
    }
  }

  // Write safety-net entry to inflight tracker
  const trackerPath = join(root, 'shared-context', user, 'inflight', `session-${pointer.name}.md`);
  if (existsSync(trackerPath)) {
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const safetyEntry = `\n### Session ended (${timestamp})\n\nReason: ${reason}. Chat session ${sessionId || 'unknown'}.\n`;
    appendFileSync(trackerPath, safetyEntry);

    // Auto-commit the tracker update to the workspace branch
    try {
      execSync(`git add "shared-context/${user}/inflight/session-${pointer.name}.md"`, { cwd: root, stdio: 'pipe' });
      execSync(`git commit -m "chore: session-end safety capture for ${pointer.name}" --allow-empty`, { cwd: root, stdio: 'pipe' });
    } catch {
      // Commit may fail if nothing changed or hooks block — not fatal
    }
  }
}

// Log to session-log.jsonl (existing behavior)
if (!existsSync(scratchpad)) mkdirSync(scratchpad, { recursive: true });

const entry = JSON.stringify({
  event: 'session_end',
  date: new Date().toISOString(),
  user,
  reason,
  session_id: sessionId,
  workspace_branch: branch,
  work_session: pointer?.name || null,
});

appendFileSync(logFile, entry + '\n');
respond();
```

- [ ] **Step 2: Verify syntax**

```bash
node -c template/.claude/hooks/session-end.mjs
```

- [ ] **Step 3: Commit**

```bash
git add template/.claude/hooks/session-end.mjs
git commit -m "feat: session-end hook updates markers and writes safety capture"
```

---

### Task 6: Expand repo-write-detection.mjs

Warn on all writes from workspace root (main) except local-only and scratchpad files.

**Files:**
- Modify: `template/.claude/hooks/repo-write-detection.mjs`

- [ ] **Step 1: Rewrite repo-write-detection.mjs**

Replace the entire file content with:

```javascript
#!/usr/bin/env node
// PreToolUse hook — enforce workspace root write restrictions
import { readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { getWorkspaceRoot, readStdin, respond, getActiveSessionPointer } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const input = await readStdin();
const toolName = input.tool_name || '';

// Only check file-writing tools
if (!['Bash', 'Edit', 'Write'].includes(toolName)) {
  respond();
  process.exit(0);
}

// Extract file paths from tool input
const toolInput = input.tool_input || {};
const paths = [toolInput.file_path, toolInput.command, toolInput.path]
  .filter(Boolean)
  .join(' ');

// If we're in a workspace worktree, check for active session marker
const pointer = getActiveSessionPointer(root);
if (pointer) {
  // In a worktree — allow all writes (session is active by definition)
  respond();
  process.exit(0);
}

// We're at the workspace root (main) — restrict writes

// Allow writes to .claude-scratchpad/
if (paths.includes('.claude-scratchpad')) {
  respond();
  process.exit(0);
}

// Allow writes to local-only-* files
const filePathArg = toolInput.file_path || '';
if (basename(filePathArg).startsWith('local-only-')) {
  respond();
  process.exit(0);
}

// For Bash commands, check if the command targets allowed paths
if (toolName === 'Bash') {
  const cmd = toolInput.command || '';
  // Allow git commands, ls, and other read-only operations
  if (/^\s*(git|ls|cat|head|tail|grep|rg|find|echo|pwd|cd|which|node\s+-c)\b/.test(cmd)) {
    respond();
    process.exit(0);
  }
  // Allow commands that only write to scratchpad or local-only files
  if (cmd.includes('.claude-scratchpad') || cmd.includes('local-only-')) {
    respond();
    process.exit(0);
  }
}

// Check if this write targets repos/, shared-context/, or template files
const isRepoWrite = paths.includes('repos/') || paths.includes('___wt-');
const isContextWrite = paths.includes('shared-context/') && !basename(filePathArg).startsWith('local-only-');
const isTemplateWrite = paths.includes('.claude/') && !paths.includes('.claude-scratchpad');

if (isRepoWrite || isContextWrite || isTemplateWrite) {
  respond("You're on main. All work should happen in a workspace worktree. Run /start-work to create or resume a work session.");
}

respond();
```

- [ ] **Step 2: Verify syntax**

```bash
node -c template/.claude/hooks/repo-write-detection.mjs
```

- [ ] **Step 3: Commit**

```bash
git add template/.claude/hooks/repo-write-detection.mjs
git commit -m "feat: expand write detection to enforce workspace root restrictions"
```

---

### Task 7: Session-aware pre-compact.mjs

Read session marker and tailor the capture nudge based on inflight tracker staleness.

**Files:**
- Modify: `template/.claude/hooks/pre-compact.mjs`

- [ ] **Step 1: Rewrite pre-compact.mjs**

Replace the entire file content with:

```javascript
#!/usr/bin/env node
// PreCompact hook — session-aware context capture nudge
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot, readJSON, respond, getActiveSessionPointer, timeAgo } from './_utils.mjs';

const root = getWorkspaceRoot(import.meta.url);
const settings = readJSON(join(root, '.claude', 'settings.local.json'));
const user = settings?.workspace?.user || 'unknown';

const pointer = getActiveSessionPointer(root);

if (pointer) {
  // In an active work session — check tracker freshness
  const trackerPath = join(root, 'shared-context', user, 'inflight', `session-${pointer.name}.md`);

  if (existsSync(trackerPath)) {
    const stat = statSync(trackerPath);
    const minsAgo = Math.floor((Date.now() - stat.mtimeMs) / 60000);

    if (minsAgo > 30) {
      respond(`Context is about to be compacted. Your session tracker for "${pointer.name}" was last updated ${timeAgo(stat.mtime.toISOString())}.\n\nConsider /handoff to update the tracker before context is lost.`);
    } else {
      respond(`Context compacting. Session tracker for "${pointer.name}" is recent (updated ${minsAgo}m ago). Earlier conversation details may still be lost — use /handoff if needed.`);
    }
  } else {
    respond(`Context is about to be compacted. No session tracker found for "${pointer.name}". Use /handoff to capture progress before context is lost.`);
  }
} else {
  // No active session — generic message
  respond(`Context is about to be compacted — earlier conversation details will be lost.\n\nIf this session produced decisions or progress worth keeping:\n  /braindump [name] — capture discussion and reasoning\n  /handoff [name]   — capture workstream state and next steps\n\nFiles in shared-context/${user}/ will persist. Conversation details won't.`);
}
```

- [ ] **Step 2: Verify syntax**

```bash
node -c template/.claude/hooks/pre-compact.mjs
```

- [ ] **Step 3: Commit**

```bash
git add template/.claude/hooks/pre-compact.mjs
git commit -m "feat: session-aware PreCompact hook with tracker staleness check"
```

---

### Task 8: Update template rules

Update git-conventions, workspace-structure, and memory-guidance for the new session model.

**Files:**
- Modify: `template/.claude/rules/git-conventions.md`
- Modify: `template/.claude/rules/workspace-structure.md`
- Modify: `template/.claude/rules/memory-guidance.md`

- [ ] **Step 1: Update git-conventions.md worktree section**

Replace the `## Worktrees` section with:

```markdown
## Worktrees

- Work sessions get two worktrees: one for the workspace, one for the project repo
- Worktree naming: `{session-name}___wt-{type}` where type is `workspace` or `{repo-name}`
- Examples: `repos/migrate-tool___wt-workspace/`, `repos/migrate-tool___wt-create-claude-workspace/`
- All worktrees for a session are adjacent in directory listings
- The main repo clone and workspace root stay on their default branches
- Remove worktrees when the work session is completed
```

- [ ] **Step 2: Update workspace-structure.md**

Replace the `## Directory Layout` table with:

```markdown
## Directory Layout

| Directory | Purpose | Tracked in git? |
|-----------|---------|-----------------|
| `repos/` | Cloned project repositories and worktrees | No (gitignored) |
| `repos/{session}___wt-workspace/` | Workspace worktree for a work session | No (gitignored) |
| `repos/{session}___wt-{repo}/` | Project repo worktree for a work session | No (gitignored) |
| `shared-context/` | Shared memory — handoffs, braindumps, team knowledge | Yes |
| `shared-context/locked/` | Team truths — loaded every session, injected into subagents | Yes |
| `shared-context/{user}/` | User-scoped working context — default for all captures | Yes |
| `shared-context/{user}/inflight/` | Current work-session artifacts — consumed by /complete-work | Yes |
| `.claude-scratchpad/` | Disposable files — session markers, temp diffs, debug output | No (gitignored) |
| `.claude/` | Claude Code configuration — rules, agents, skills, hooks, scripts | Yes (except settings.local.json) |
```

Replace the `## Rules` section with:

```markdown
## Rules

- The workspace root stays on main — it is the launcher, not the workspace
- All real work happens in workspace worktrees (`repos/{session}___wt-workspace/`)
- From the workspace root, only `local-only-*` files and `.claude-scratchpad/` are writable
- Worktrees live inside `repos/` as siblings to their source repo
- The main repo clone stays on its default branch — never checkout a feature branch there
- `.claude-scratchpad/` is for disposable files only — session markers, temp output, pointers
```

Replace the `## Naming Conventions` section with:

```markdown
## Naming Conventions

- Specs: `design-{topic}.md`
- Plans: `plan-{topic}.md`
- Handoffs and braindumps: named by topic (no date prefix — use frontmatter `updated:`)
- Worktrees: `{session-name}___wt-workspace` or `{session-name}___wt-{repo-name}`
- Session markers: `.work-session-{session-name}.json`
- Inflight trackers: `session-{session-name}.md`
```

- [ ] **Step 3: Update memory-guidance.md**

Add a new section after "What NOT to Auto-Remember":

```markdown
## Session-Scoped vs Cross-Session

When a work session is active:
- Decisions and progress from this session → update the inflight tracker (consumed by /complete-work)
- Patterns, corrections, and insights that apply beyond this session → auto-memory (persists across all sessions)
- Don't duplicate: if something is already in the inflight tracker, don't also save it to auto-memory
```

- [ ] **Step 4: Commit**

```bash
git add template/.claude/rules/git-conventions.md template/.claude/rules/workspace-structure.md template/.claude/rules/memory-guidance.md
git commit -m "feat: update rules for persistent work sessions and workspace worktrees"
```

---

### Task 9: Rewrite start-work/SKILL.md

The skill gets significantly reworked for persistent sessions, workspace worktrees, and history reconstruction.

**Files:**
- Modify: `template/.claude/skills/start-work/SKILL.md`

- [ ] **Step 1: Rewrite the skill**

Replace the entire file content with:

````markdown
---
name: start-work
description: Begin or resume a work session. Creates workspace + project worktrees for parallel session support. Accepts optional parameter "handoff" or "blank".
---

# Start Work

Begin or resume a persistent work session. Each session gets its own workspace worktree and project worktree, enabling parallel sessions in separate terminal windows.

## Parameters
- `/start-work` (no param) — check for active sessions, then resume or start new
- `/start-work blank` — start new work from scratch
- `/start-work handoff` — list shared context to resume from

## Flow: No Parameter

1. Read session markers from `.claude-scratchpad/` (all `.work-session-*.json` files)
2. If active sessions exist, present them:
   ```
   Active work sessions:
     1. migrate-tool (active, last chat ended 2h ago)
        "Rewriting the migration module"
        Branch: bugfix/migrate-rewrite | Repo: create-claude-workspace
     
     [N] Start something new
   
   Which one?
   ```
3. User picks one → resume flow
4. User picks "new" → blank flow
5. If no sessions exist: proceed as `blank`

## Flow: Resume

1. Read the selected session marker
2. Verify worktrees exist:
   - Workspace: `repos/{session-name}___wt-workspace/`
   - Project: `repos/{session-name}___wt-{repo}/`
   - If missing, recreate from the branch
3. Register this chat in the session marker:
   ```bash
   # Read the marker, append this chat's session ID to chatSessions with ended: null
   ```
4. Update marker status to `active` if it was `paused`
5. Run history reconstruction (see below)
6. Tell user: "Resuming {name}. Work from `repos/{session-name}___wt-workspace/`."

### History Reconstruction

On resume, check for uncaptured work from previous chats:

1. Read the session marker's `chatSessions` array
2. For the most recent ended chat, check if the inflight tracker was updated after it ended
3. Look in `~/.claude/projects/{project-path}/` for message history matching the chat session ID
4. If there's a gap (history is newer than tracker): scan those messages and generate a summary
5. Append the summary to the inflight tracker
6. Tell user: "Found uncaptured work from your last chat. Updated the session tracker."

If no gap is found, skip silently.

## Flow: Blank (new session)

1. Ask: "What are you working on?"
2. Wait for response
3. Generate session name from description (kebab-case slug)
4. Determine type: feature, bugfix, or chore
5. Ask which repo (if multiple repos in workspace.json)
6. Propose branch: "How about `{prefix}/{session-name}`?"
7. Wait for confirmation

### Create work session

Run the helper script:
```bash
node .claude/scripts/create-work-session.mjs \
  --session-name "{session-name}" \
  --branch "{branch}" \
  --repo "{repo}" \
  --user "{user}" \
  --description "{description}"
```

The script creates:
- Workspace worktree at `repos/{session-name}___wt-workspace/`
- Project worktree at `repos/{session-name}___wt-{repo}/`
- Symlinks `repos/` into the workspace worktree
- Copies `settings.local.json` into the worktree
- Session marker in `.claude-scratchpad/`
- Active-session pointer in the worktree's `.claude-scratchpad/`
- Inflight tracker in `shared-context/{user}/inflight/`

Register this chat's session ID in the marker.

Tell user: "Work session started. Work from `repos/{session-name}___wt-workspace/`."

### Stale worktree check

Before creating a new session, scan for existing worktrees:
```bash
ls repos/ | grep '___wt-'
```
If stale worktrees exist (no recent commits, no open PR):
- "You have existing worktrees for {sessions}. Clean up? [y/N]"
- If yes: run cleanup script for each

### Next steps

If superpowers-workflow rule is active: run mandatory research phase, then invoke brainstorming skill.
If not: ask "Ready to start implementing, or want to brainstorm first?"

## Flow: Retroactive (called mid-session)

When /start-work is called after work has already begun:

1. Detect uncommitted changes in repos/ or shared-context/
2. "It looks like you've already been working. Let me formalize this."
3. If changes are on a default branch: stash → create session → pop stash
4. If changes are already on a feature branch: create workspace worktree to match
5. Summarize: "Formalized as work session: {name}. Work from `repos/{name}___wt-workspace/`."

## Notes
- Both repos get the same branch name for traceability
- Each session gets its own workspace worktree — the root stays on main
- The workspace worktree has a `repos/` symlink for project worktree access
- inflight/ is created per work session, consumed by /complete-work
- Auto-committing session markers is a workflow artifact — this intentionally bypasses normal commit conventions
````

- [ ] **Step 2: Commit**

```bash
git add template/.claude/skills/start-work/SKILL.md
git commit -m "feat: rewrite start-work for persistent sessions with workspace worktrees"
```

---

### Task 10: Update pause-work/SKILL.md

Change to write status to inflight tracker and update session marker.

**Files:**
- Modify: `template/.claude/skills/pause-work/SKILL.md`

- [ ] **Step 1: Read the current file**

Read `template/.claude/skills/pause-work/SKILL.md` to understand the current structure before rewriting.

- [ ] **Step 2: Rewrite the skill**

Replace the entire file with:

````markdown
---
name: pause-work
description: Suspend current work — updates session marker, captures state to inflight tracker, pushes both repos, creates draft PRs. Use when stepping away from work that isn't finished.
---

# Pause Work

Suspend the active work session. Captures state, pushes work, and marks the session as paused for later resumption.

## Flow

### Step 1: Detect active session

Read the active-session pointer from `.claude-scratchpad/.active-session.json`.
If no active session: "No active work session. Nothing to pause."

Read the full session marker from the main root's `.claude-scratchpad/`.

### Step 2: Update inflight tracker

Write a status summary to the inflight tracker at `shared-context/{user}/inflight/session-{session-name}.md`:

Update the Progress section with:
- What was accomplished in this chat session
- Key decisions made
- Current state of the work
- Specific next steps for whoever resumes

This is a coherent rewrite of the Progress section, not an append (coherent-revisions rule).

### Step 3: Update session marker

Set `status: "paused"` and record this chat's `ended` timestamp in the marker.

### Step 4: Commit and push workspace

```bash
# From the workspace worktree
git add shared-context/
git commit -m "handoff: pause {session-name}"
git push -u origin {branch}
```

### Step 5: Push project repo

```bash
# From the project worktree
cd repos/{session-name}___wt-{repo}
git push -u origin {branch}
```

### Step 6: Create draft PRs

```bash
# Project repo
cd repos/{session-name}___wt-{repo}
gh pr create --draft --title "WIP: {description}" --body "Work in progress. Session paused."

# Workspace repo — from workspace worktree
gh pr create --draft --title "context: {session-name} (paused)" --body "Workspace context for paused session."
```

### Step 7: Confirm

"Session '{session-name}' paused. Resume anytime with /start-work."

No worktree cleanup — the session is meant to be resumed.

## Notes
- Pause writes ONLY to `{user}/inflight/` — never to ongoing or root shared-context
- The session marker stays in `.claude-scratchpad/` — it's the resume mechanism
- Draft PRs signal work-in-progress without implying merge readiness
- Auto-committing the pause capture is a workflow artifact — this intentionally bypasses normal commit conventions
````

- [ ] **Step 3: Commit**

```bash
git add template/.claude/skills/pause-work/SKILL.md
git commit -m "feat: rewrite pause-work for persistent sessions"
```

---

### Task 11: Update complete-work/SKILL.md

Add unified PR presentation, workspace worktree cleanup, and session marker deletion.

**Files:**
- Modify: `template/.claude/skills/complete-work/SKILL.md`

- [ ] **Step 1: Read the current file**

Read `template/.claude/skills/complete-work/SKILL.md` to understand the current structure.

- [ ] **Step 2: Rewrite the skill**

Replace the entire file with:

````markdown
---
name: complete-work
description: Finalize a work session — rebase, synthesize release notes from specs/plans/tracker/commits, create PRs with unified presentation. Handles both project repo and workspace repo. Use when work on a session is done.
---

# Complete Work

Finalize the active work session. Handles both the project repo (code changes, release notes, PR) and the workspace repo (context processing, PR). Presents a unified summary with a single merge approval.

## Flow

### Step 1: Detect context

Read the active-session pointer from `.claude-scratchpad/.active-session.json`.
If no active session: "No active work session. Nothing to complete."

Read the full session marker from the main root's `.claude-scratchpad/`.

Determine paths:
- Workspace worktree: `repos/{session-name}___wt-workspace/`
- Project worktree: `repos/{session-name}___wt-{repo}/`
- Read the repo's branch from workspace.json (`repos.{repo}.branch`)

### Step 2: Rebase project repo

```bash
# {repo-branch} = repos.{repo}.branch from workspace.json
cd repos/{session-name}___wt-{repo}
git fetch origin
git rebase origin/{repo-branch}
```
If conflicts arise, STOP and present them to the user. Do not auto-resolve.

### Step 3: Capture final discussion state

Run `/braindump` to capture any final discussion/reasoning to the inflight tracker.
If the user declines or there's nothing to capture, skip.

### Step 4: Gather source material

Formally read ALL sources before synthesizing — do not write release notes from memory alone:

1. **Inflight tracker** at `shared-context/{user}/inflight/session-{session-name}.md`
2. **Branch-scoped specs/plans** in the worktree or inflight/:
   - `design-*.md` files
   - `plan-*.md` files
3. **Handoffs** — any shared-context entries referencing this branch:
   ```bash
   grep -rl "branch: {branch}" shared-context/
   ```
4. **Branch commit log:**
   ```bash
   git log origin/{repo-branch}..HEAD --oneline
   ```

### Step 5: Synthesize release notes

Create two files in the **project repo** worktree:

```bash
COMMIT_ID=$(git rev-parse --short HEAD)
mkdir -p release-notes/unreleased
```

**File 1: `release-notes/unreleased/branch-release-notes-{COMMIT_ID}.md`**
```markdown
---
branch: {branch}
type: {feature|fix|chore}
author: {user}
date: {YYYY-MM-DD}
---

## {Human-readable title}

{Coherent narrative synthesized from tracker + spec + plan + commits.
Written from scratch per coherent-revisions rule.}
```

**File 2: `release-notes/unreleased/branch-release-questions-{COMMIT_ID}.md`**
```markdown
---
branch: {branch}
author: {user}
date: {YYYY-MM-DD}
---

## Open Questions

{Only genuinely open questions — not things resolved during implementation.}
```

Commit to the project repo worktree:
```bash
git add release-notes/unreleased/
git commit -m "docs: add release notes for {branch}"
```

### Step 6: Consume branch-scoped sources

Remove branch-scoped specs and plans from the project worktree:
```bash
cd repos/{session-name}___wt-{repo}
rm -f design-*.md plan-*.md
git add -u && git commit -m "chore: remove consumed branch-scoped specs and plans"
```

### Step 7: Check for no-remote

```bash
git remote -v
```
If no remote: "No remote configured for {repo}. Want me to create one on GitHub, or provide a URL?"

### Step 8: Push both repos

```bash
# Project repo
cd repos/{session-name}___wt-{repo}
git push -u origin {branch}

# Workspace repo
cd repos/{session-name}___wt-workspace
git add shared-context/
git commit -m "chore: finalize context for {session-name}"
git push -u origin {branch}
```

### Step 9: Create PRs and present unified summary

Create both PRs, then present a single unified summary:

```bash
# Project PR
cd repos/{session-name}___wt-{repo}
gh pr create --title "{type}: {description}" --body "..."

# Workspace PR
cd repos/{session-name}___wt-workspace
gh pr create --title "context: {session-name} work session" --body "..."
```

Present unified summary:
```
Work session complete:

PROJECT: {repo}
  PR #{n}: {type}: {description}
  Branch: {branch} → {repo-branch}
  Changes:
    - {bullet points from release notes}
  Release notes: branch-release-notes-{COMMIT_ID}.md

WORKSPACE: {workspace-name}
  PR #{m}: context: {session-name} work session
  Branch: {branch} → main
  Changes:
    - {summary of shared-context changes}

Merge both? [Y/n]
```

If yes:
```bash
gh pr merge {project-pr} --merge
gh pr merge {workspace-pr} --merge
```

Pull both repos to main:
```bash
cd repos/{repo} && git pull origin {repo-branch}
cd {workspace-root} && git pull origin main
```

### Step 10: Cleanup

Run the cleanup helper script:
```bash
node .claude/scripts/cleanup-work-session.mjs --session-name "{session-name}"
```

This removes:
- Workspace worktree
- Project worktree
- Local branches in both repos
- Session marker

Verify workspace root is still on main:
```bash
git branch --show-current  # should be "main"
```

## Notes
- Release notes live in the PROJECT repo worktree — never the workspace
- The inflight tracker is the primary source for release note synthesis — it captures the full session history
- Both repos get PRed and merged together — one approval for both
- Context consumption, cleanup, and auto-committing release notes are intentional workflow behavior — these bypass normal commit conventions by design
````

- [ ] **Step 3: Commit**

```bash
git add template/.claude/skills/complete-work/SKILL.md
git commit -m "feat: rewrite complete-work with unified PR workflow and session cleanup"
```

---

### Task 12: Update handoff and braindump skills

Within a work session, these default to updating the inflight tracker instead of creating separate files.

**Files:**
- Modify: `template/.claude/skills/handoff/SKILL.md`
- Modify: `template/.claude/skills/braindump/SKILL.md`

- [ ] **Step 1: Read current handoff and braindump skills**

Read both files to understand the current structure before modifying.

- [ ] **Step 2: Update handoff skill**

Add a new section after `## Parameters` and before `## Flow: Named`:

```markdown
## Session-Aware Behavior

When called within an active work session (`.claude-scratchpad/.active-session.json` exists):

- Default behavior: update the inflight tracker at `shared-context/{user}/inflight/session-{session-name}.md`
- Rewrite the tracker's Progress section with current state (coherent-revisions rule)
- Skip the naming and scoping questions — the tracker is already scoped to this session
- Auto-commit the update:
  ```bash
  git add shared-context/{user}/inflight/session-{session-name}.md
  git commit -m "handoff: update {session-name} tracker"
  ```

When called from the workspace root (no active session):
- Only `local-only-*` files are writable from the root
- Suggest starting a work session first, or create a `local-only-{name}.md` file

The flows below apply when NOT in an active work session, or when the user explicitly asks for a standalone handoff file.
```

- [ ] **Step 3: Update braindump skill**

Add a new section after `## Parameters` and before `## Flow: Named`:

```markdown
## Session-Aware Behavior

When called within an active work session (`.claude-scratchpad/.active-session.json` exists):

- Default behavior: append reasoning and decisions to the inflight tracker at `shared-context/{user}/inflight/session-{session-name}.md`
- Add a new section to the tracker with the braindump content (Context, Exploration, Decisions, Implications)
- Auto-commit the update:
  ```bash
  git add shared-context/{user}/inflight/session-{session-name}.md
  git commit -m "braindump: update {session-name} tracker"
  ```

When called from the workspace root (no active session):
- Create a `local-only-{name}.md` file (root only allows local-only writes)
- Suggest starting a work session if the braindump is about actionable work

`/braindump side {name}` always creates a separate `local-only-{name}.md` file regardless of session state — it's for unrelated ideas.

The flows below apply when NOT in an active work session, or when the user explicitly asks for a standalone braindump file.
```

- [ ] **Step 4: Commit**

```bash
git add template/.claude/skills/handoff/SKILL.md template/.claude/skills/braindump/SKILL.md
git commit -m "feat: session-aware handoff and braindump with inflight tracker integration"
```

---

### Task 13: Update settings.json and add .gitignore entry

Ensure the scripts directory is properly configured and workspace worktree symlinks are gitignored.

**Files:**
- Modify: `template/_gitignore`

- [ ] **Step 1: Read current _gitignore**

Read `template/_gitignore` to understand the current entries.

- [ ] **Step 2: Add repos/ symlink to gitignore**

The workspace worktree will contain a `repos/` symlink. Since workspace worktrees are in `repos/` (which is already gitignored at the workspace level), this shouldn't be an issue. But the worktree's own `.gitignore` (from the workspace repo) needs to ignore the `repos` symlink that gets created inside it.

Add to the gitignore file:

```
# Symlink created in workspace worktrees
repos
```

Note: this line should only be added if `repos` isn't already in the gitignore. Check the current contents first.

- [ ] **Step 3: Commit**

```bash
git add template/_gitignore
git commit -m "chore: gitignore repos symlink in workspace worktrees"
```
