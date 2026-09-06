#!/usr/bin/env node
// Unit tests for workspace-diagnostics.mjs
// Run: node .claude/scripts/workspace-diagnostics.test.mjs
//
// Never reads the real ~/.claude/projects or the real workspace — every
// test builds its own fixture tree under mkdtempSync(os.tmpdir()) and
// points the diagnostics functions at it via their injectable parameters
// (projectsDir / claudeHome / root are all explicit arguments).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveProjectsSlug,
  resolveProjectsDir,
  aggregateTranscripts,
  aggregateSessionLog,
  readTemplateVersion,
  listAvailableSkills,
  loadFootprint,
  buildReport,
  renderMarkdown,
  scanForLeaks,
  isAfterOrEqual,
  mapToSortedArray,
  computeMinMedianMax,
} from './workspace-diagnostics.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

function writeTranscript(projectsDir, sessionId, records) {
  mkdirSync(projectsDir, { recursive: true });
  const lines = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  writeFileSync(join(projectsDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function skillToolUse(skillName) {
  return { type: 'tool_use', name: 'Skill', input: { skill: skillName } };
}

function assistantRecord({ content, cwd, gitBranch, version, timestamp }) {
  return {
    type: 'assistant',
    timestamp: timestamp || '2026-04-25T00:00:00.000Z',
    cwd: cwd || '/fixture/cwd',
    gitBranch: gitBranch || 'main',
    version: version || '2.1.251',
    sessionId: 'fixture-session',
    isSidechain: false,
    message: { content },
  };
}

// ============================================================
console.log('# deriveProjectsSlug / resolveProjectsDir');

{
  assertEq(deriveProjectsSlug('/foo/bar.baz/qux'), '-foo-bar-baz-qux', 'slashes and dots replaced with dashes');
}

{
  const claudeHome = tmpRoot('wd-claudehome-');
  const dir = resolveProjectsDir('/some/fixture/root', claudeHome);
  assertEq(dir, join(claudeHome, 'projects', '-some-fixture-root'), 'resolveProjectsDir composes claudeHome + slug');
  cleanup(claudeHome);
}

// ============================================================
console.log('# skill counting from transcript records');

{
  const claudeHome = tmpRoot('wd-ch-');
  const projectsDir = join(claudeHome, 'projects', '-fixture-root-1');
  writeTranscript(projectsDir, 'sess-1', [
    assistantRecord({
      content: [
        skillToolUse('start-work'),
        { type: 'tool_use', name: 'Read', input: { file_path: '/should/not/be/read' } },
        skillToolUse('start-work'),
      ],
    }),
    assistantRecord({ content: [skillToolUse('handoff')] }),
  ]);

  const result = aggregateTranscripts({ projectsDir });
  assert(result.available, 'transcripts available');
  const skillMap = Object.fromEntries(result.skillCounts.map((s) => [s.name, s.count]));
  assertEq(skillMap['start-work'], 2, 'start-work counted twice (multiple tool_use blocks in one message)');
  assertEq(skillMap['handoff'], 1, 'handoff counted once');
  const toolMap = Object.fromEntries(result.toolCounts.map((t) => [t.name, t.count]));
  assertEq(toolMap['Read'], 1, 'non-Skill tool_use counted in tool mix');
  assertEq(skillMap['Read'], undefined, 'non-Skill tool_use never counted as a skill');
  cleanup(claudeHome);
}

// ============================================================
console.log('# malformed JSON lines are skipped without throwing');

{
  const claudeHome = tmpRoot('wd-ch-');
  const projectsDir = join(claudeHome, 'projects', '-fixture-root-2');
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    join(projectsDir, 'sess-bad.jsonl'),
    [
      JSON.stringify(assistantRecord({ content: [skillToolUse('braindump')] })),
      '{not valid json at all',
      '',
      JSON.stringify(assistantRecord({ content: [skillToolUse('braindump')] })),
    ].join('\n'),
  );

  let result;
  let threw = false;
  try {
    result = aggregateTranscripts({ projectsDir });
  } catch {
    threw = true;
  }
  assert(!threw, 'malformed line does not throw');
  const skillMap = Object.fromEntries(result.skillCounts.map((s) => [s.name, s.count]));
  assertEq(skillMap['braindump'], 2, 'both valid lines still counted around the malformed one');
  cleanup(claudeHome);
}

// ============================================================
console.log('# cwd transitions counted correctly');

{
  const claudeHome = tmpRoot('wd-ch-');
  const projectsDir = join(claudeHome, 'projects', '-fixture-root-3');
  writeTranscript(projectsDir, 'sess-cwd', [
    assistantRecord({ content: [], cwd: '/a' }),
    assistantRecord({ content: [], cwd: '/a' }),
    assistantRecord({ content: [], cwd: '/b' }),
  ]);
  const result = aggregateTranscripts({ projectsDir });
  assertEq(result.cwdTransitions, 1, '3 records, one change -> 1 transition');
  cleanup(claudeHome);
}

// ============================================================
console.log('# distinct branch counting emits counts only, never names');

{
  const claudeHome = tmpRoot('wd-ch-');
  const projectsDir = join(claudeHome, 'projects', '-fixture-root-4');
  writeTranscript(projectsDir, 'sess-branch', [
    assistantRecord({ content: [], gitBranch: 'feature/super-secret-thing' }),
    assistantRecord({ content: [], gitBranch: 'feature/super-secret-thing' }),
    assistantRecord({ content: [], gitBranch: 'main' }),
  ]);
  const result = aggregateTranscripts({ projectsDir });
  assertEq(result.distinctBranchCount.overall, 2, 'two distinct branches counted');
  assertEq(typeof result.distinctBranchCount.overall, 'number', 'distinct branch count is a number');

  const agg = {
    generatedAt: 'now',
    since: null,
    templateVersion: '1.2.3',
    transcripts: result,
    zeroInvocationSkills: [],
    sessionLog: { available: false },
    footprint: { available: false, reason: 'test' },
  };
  const rendered = renderMarkdown(agg);
  assert(!rendered.includes('feature/super-secret-thing'), 'branch name never appears in rendered report');
  assert(rendered.includes('overall: 2'), 'overall distinct-branch count appears in rendered report');
  cleanup(claudeHome);
}

// ============================================================
console.log('# session-log aggregation by event and reason');

{
  const root = tmpRoot('wd-root-');
  mkdirSync(join(root, 'workspace-scratchpad'), { recursive: true });
  const lines = [
    { event: 'pause', date: '2026-04-20T00:00:00Z', user: 'someone', reason: 'other', session_id: 'abc-123', workspace_branch: 'feature/x', work_session: 'topsecret' },
    { event: 'pause', date: '2026-04-21T00:00:00Z', user: 'someone', reason: 'clear', session_id: 'def-456' },
    { event: 'resume', date: '2026-04-22T00:00:00Z', user: 'someone', reason: 'resume', session_id: 'ghi-789' },
  ];
  writeFileSync(join(root, 'workspace-scratchpad', 'session-log.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const result = aggregateSessionLog(root);
  assert(result.available, 'session log available');
  const eventMap = Object.fromEntries(result.eventCounts.map((e) => [e.name, e.count]));
  const reasonMap = Object.fromEntries(result.reasonCounts.map((r) => [r.name, r.count]));
  assertEq(eventMap['pause'], 2, 'pause counted twice');
  assertEq(eventMap['resume'], 1, 'resume counted once');
  assertEq(reasonMap['other'], 1, 'reason other counted once');
  assertEq(reasonMap['clear'], 1, 'reason clear counted once');
  assertEq(reasonMap['resume'], 1, 'reason resume counted once');

  const serialized = JSON.stringify(result);
  assert(!serialized.includes('someone'), 'user field never surfaces');
  assert(!serialized.includes('abc-123'), 'session_id never surfaces');
  assert(!serialized.includes('feature/x'), 'workspace_branch never surfaces');
  assert(!serialized.includes('topsecret'), 'work_session never surfaces');
  cleanup(root);
}

{
  // missing session-log.jsonl → unavailable, no crash
  const root = tmpRoot('wd-root-');
  const result = aggregateSessionLog(root);
  assertEq(result, { available: false }, 'missing session-log.jsonl reports unavailable');
  cleanup(root);
}

// ============================================================
console.log('# scanForLeaks');

{
  assert(scanForLeaks('safe report text with only counts: 42').length === 0, 'clean text returns []');
}

{
  const hits = scanForLeaks('see /Users/someone/private/notes.md for details');
  assert(hits.some((h) => h.pattern === 'absolute-path'), 'catches /Users/ absolute path');
}

{
  const hits = scanForLeaks('contact me at person@example.com please');
  assert(hits.some((h) => h.pattern === 'email-address'), 'catches email address');
}

{
  const hits = scanForLeaks('working on feature/acme-secret-project this week');
  assert(hits.some((h) => h.pattern === 'git-branch-token'), 'catches feature/-style branch token');
}

{
  const hits = scanForLeaks('session id 276f426a-6352-4254-8778-ba9792fad0c6 was active');
  assert(hits.some((h) => h.pattern === 'uuid'), 'catches bare UUID');
}

{
  const hits = scanForLeaks('the operator here is myronwashere doing work', { username: 'myronwashere' });
  assert(hits.some((h) => h.pattern === 'os-username'), 'catches injected OS username');
}

{
  // framework-relative paths (footprint files[].path) must NOT be flagged —
  // only absolute forms are unsafe.
  const hits = scanForLeaks('| .claude/rules/git-conventions.md | 1024 | rule |');
  assert(hits.length === 0, 'framework-relative path is not flagged as a leak');
}

// ============================================================
console.log('# end-to-end privacy test (the most important one)');

{
  const root = tmpRoot('wd-e2e-root-');
  const claudeHome = tmpRoot('wd-e2e-ch-');
  const projectsDir = join(claudeHome, 'projects', deriveProjectsSlugForTest(root));

  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace: { templateVersion: '0.17.0-beta.0' } }));
  mkdirSync(join(root, '.claude', 'skills', 'start-work'), { recursive: true });

  writeTranscript(projectsDir, 'e2e-session', [
    {
      type: 'user',
      timestamp: '2026-04-25T00:00:00.000Z',
      cwd: '/Users/realperson/private',
      gitBranch: 'feature/acme-secret-project',
      version: '2.1.251',
      sessionId: 'e2e-session',
      isSidechain: false,
      message: { role: 'user', content: 'the password is hunter2, my email is realperson@acme-corp.com' },
    },
    assistantRecord({
      content: [
        { type: 'thinking', thinking: 'the user realperson@acme-corp.com wants me to use hunter2 as the password' },
        { type: 'text', text: 'Sure, the password is hunter2.' },
        skillToolUse('start-work'),
      ],
      cwd: '/Users/realperson/private',
      gitBranch: 'feature/acme-secret-project',
    }),
  ]);

  const agg = await buildReport({ root, claudeHome });
  const rendered = renderMarkdown(agg);

  const sensitiveStrings = [
    'hunter2',
    'feature/acme-secret-project',
    '/Users/realperson/private',
    'realperson@acme-corp.com',
  ];
  for (const s of sensitiveStrings) {
    assert(!rendered.includes(s), `report never contains sensitive string: ${s}`);
  }
  assert(!JSON.stringify(agg).includes('hunter2'), 'raw aggregate object never contains the sensitive password string');

  // Positive assertions: the aggregate counts are still present.
  assert(rendered.includes('Transcript (session) count: 1'), 'transcript count present');
  assert(rendered.includes('start-work'), 'skill name (not content) present');
  assert(rendered.includes('overall: 1'), 'distinct branch count present');

  const leaks = scanForLeaks(rendered);
  assertEq(leaks, [], 'leak scan finds nothing in the generated report');

  cleanup(root, claudeHome);
}

function deriveProjectsSlugForTest(root) {
  return deriveProjectsSlug(root);
}

// ============================================================
console.log('# cwd-independence regression test');

{
  const fixtureRoot = tmpRoot('wd-cwd-fixture-root-');
  const claudeHome = tmpRoot('wd-cwd-fixture-ch-');
  const otherCwd = tmpRoot('wd-cwd-elsewhere-');

  writeFileSync(join(fixtureRoot, 'workspace.json'), JSON.stringify({ workspace: { templateVersion: '9.9.9' } }));
  const projectsDir = join(claudeHome, 'projects', deriveProjectsSlug(fixtureRoot));
  writeTranscript(projectsDir, 'cwd-indep-session', [
    assistantRecord({ content: [skillToolUse('pause-work')] }),
  ]);

  const before = readdirSync(otherCwd);
  const originalCwd = process.cwd();
  let agg;
  try {
    process.chdir(otherCwd);
    agg = await buildReport({ root: fixtureRoot, claudeHome });
  } finally {
    process.chdir(originalCwd);
  }

  assert(agg.templateVersion === '9.9.9', 'correct templateVersion read despite different process.cwd()');
  const skillMap = Object.fromEntries(agg.transcripts.skillCounts.map((s) => [s.name, s.count]));
  assertEq(skillMap['pause-work'], 1, 'correct skill counts read despite different process.cwd()');

  const after = readdirSync(otherCwd);
  assertEq(after, before, 'nothing was written into the unrelated cwd directory');

  cleanup(fixtureRoot, claudeHome, otherCwd);
}

// ============================================================
console.log('# readTemplateVersion / listAvailableSkills');

{
  const root = tmpRoot('wd-tv-');
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace: { templateVersion: '0.17.0-beta.0' } }));
  assertEq(readTemplateVersion(root), '0.17.0-beta.0', 'templateVersion read from workspace.json');
  cleanup(root);
}

{
  const root = tmpRoot('wd-tv-missing-');
  assertEq(readTemplateVersion(root), null, 'missing workspace.json -> null, no throw');
  cleanup(root);
}

{
  const root = tmpRoot('wd-skills-');
  mkdirSync(join(root, '.claude', 'skills', 'start-work'), { recursive: true });
  mkdirSync(join(root, '.claude', 'skills', 'handoff'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'not-a-dir.md'), 'x');
  assertEq(listAvailableSkills(root), ['handoff', 'start-work'], 'lists skill directories only, sorted');
  cleanup(root);
}

// ============================================================
console.log('# loadFootprint gracefully reports unavailable when the module is missing');

{
  // context-footprint.mjs is being developed in parallel and may not exist
  // yet in this checkout. Either way loadFootprint must not throw.
  const root = tmpRoot('wd-fp-');
  let threw = false;
  let result;
  try {
    result = await loadFootprint(root);
  } catch {
    threw = true;
  }
  assert(!threw, 'loadFootprint never throws');
  assert(typeof result.available === 'boolean', 'loadFootprint always returns an availability flag');
  cleanup(root);
}

// ============================================================
console.log('# small helper functions');

{
  assertEq(mapToSortedArray(new Map([['b', 1], ['a', 2]])), [{ name: 'a', count: 2 }, { name: 'b', count: 1 }], 'sorted desc by count, then name');
}

{
  assertEq(computeMinMedianMax([]), { min: 0, median: 0, max: 0 }, 'empty array -> zeros');
  assertEq(computeMinMedianMax([5]), { min: 5, median: 5, max: 5 }, 'single value');
  assertEq(computeMinMedianMax([1, 2, 3, 4]), { min: 1, median: 2.5, max: 4 }, 'even-length median averages middle two');
}

{
  assert(isAfterOrEqual(undefined, null), 'no since filter -> always true');
  assert(isAfterOrEqual('not-a-date', new Date('2026-01-01')), 'unparsable timestamp fails open (kept)');
  assert(isAfterOrEqual('2026-06-01T00:00:00Z', new Date('2026-01-01')), 'timestamp after since -> true');
  assert(!isAfterOrEqual('2025-01-01T00:00:00Z', new Date('2026-01-01')), 'timestamp before since -> false');
}

// ============================================================
console.log('# --since filters records');

{
  const claudeHome = tmpRoot('wd-ch-');
  const projectsDir = join(claudeHome, 'projects', '-fixture-root-since');
  writeTranscript(projectsDir, 'sess-since', [
    assistantRecord({ content: [skillToolUse('old-skill-use')], timestamp: '2025-01-01T00:00:00Z' }),
    assistantRecord({ content: [skillToolUse('recent-skill-use')], timestamp: '2026-06-01T00:00:00Z' }),
  ]);
  const result = aggregateTranscripts({ projectsDir, sinceDate: new Date('2026-01-01T00:00:00Z') });
  const skillMap = Object.fromEntries(result.skillCounts.map((s) => [s.name, s.count]));
  assertEq(skillMap['old-skill-use'], undefined, 'record before --since excluded');
  assertEq(skillMap['recent-skill-use'], 1, 'record after --since included');
  cleanup(claudeHome);
}

// ============================================================
console.log('# missing projects directory reports unavailable, not a crash');

{
  const claudeHome = tmpRoot('wd-ch-missing-');
  const projectsDir = join(claudeHome, 'projects', '-does-not-exist');
  const result = aggregateTranscripts({ projectsDir });
  assertEq(result, { available: false }, 'missing projects dir -> unavailable');
  cleanup(claudeHome);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
