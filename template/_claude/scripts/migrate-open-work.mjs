#!/usr/bin/env node
// One-shot migration: read an open-work.md file and create real issues via the
// configured tracker adapter. Prints the {source_id → issue_id} mapping at the
// end. NOT idempotent — if it fails partway, clean up orphan issues manually
// and re-run.
//
// Usage:
//   node .claude/scripts/migrate-open-work.mjs <path-to-open-work.md> [workspace-json-path]

import '../lib/require-node.mjs';
import { readFileSync } from 'node:fs';
import { createTracker } from './trackers/interface.mjs';

const openWorkPath = process.argv[2];
const workspaceJsonPath = process.argv[3] || 'workspace.json';

if (!openWorkPath) {
  console.error('Usage: migrate-open-work.mjs <path-to-open-work.md> [workspace-json-path]');
  process.exit(1);
}

const workspace = JSON.parse(readFileSync(workspaceJsonPath, 'utf-8'));
const trackerConfig = workspace.workspace?.tracker;
if (!trackerConfig) {
  console.error('No tracker configured in workspace.json — run /setup-tracker first.');
  process.exit(1);
}

const tracker = createTracker(trackerConfig);
const content = readFileSync(openWorkPath, 'utf-8');

// Parse ticket rows. Matches the 8-column milestone-aware format.
const rowRe = /^\|\s*(\d+)\s*\|\s*(bug|feat|chore)\s*\|\s*(P[123])\s*\|\s*([^|]+?)\s*\|\s*(open|in-progress|paused|done)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/gm;
const detailRe = /^### #(\d+)\s*—\s*[^\n]+\n\n([\s\S]+?)(?=^### #\d+|<!-- tracker-state|\Z)/gm;

const details = {};
for (const m of content.matchAll(detailRe)) {
  details[parseInt(m[1], 10)] = m[2].trim();
}

const tickets = [];
for (const m of content.matchAll(rowRe)) {
  const id = parseInt(m[1], 10);
  const msRaw = m[4].trim();
  tickets.push({
    id,
    type: m[2],
    priority: m[3],
    milestone: msRaw === '—' || msRaw === '' ? null : msRaw,
    status: m[5],
    branch: m[6].trim() === '—' ? null : m[6].trim(),
    title: m[7].trim(),
    body: details[id] || '',
  });
}

console.log(`Tracker: ${tracker.identity}`);
console.log(`Found ${tickets.length} tickets in ${openWorkPath}.\n`);

const mapping = [];

for (const ticket of tickets) {
  console.log(`Creating #${ticket.id} — ${ticket.title} [${ticket.type}/${ticket.priority}]`);
  const labels = [ticket.type, ticket.priority];
  const body = [
    ticket.body || '_No details in open-work.md._',
    '',
    '---',
    '',
    `Migrated from \`workspace-context/open-work.md\` ticket #${ticket.id} (status at migration: \`${ticket.status}\`${ticket.branch ? `, branch: \`${ticket.branch}\`` : ''}).`,
  ].join('\n');

  const issue = await tracker.createIssue({ title: ticket.title, body, labels, milestone: ticket.milestone });
  mapping.push({ sourceId: ticket.id, issueId: issue.id, number: issue.number, url: issue.url, status: ticket.status });

  if (ticket.status === 'in-progress' || ticket.status === 'paused') {
    try {
      await tracker.claim(issue.id);
      console.log(`  → claimed (status was ${ticket.status})`);
    } catch (e) {
      console.warn(`  ! claim failed: ${e.message}`);
    }
  }

  console.log(`  → ${issue.url}`);
}

console.log('\n=== Migration mapping ===');
for (const row of mapping) {
  console.log(`#${row.sourceId} → ${row.issueId} (${row.url}) [was ${row.status}]`);
}
console.log(`\nDone. Delete ${openWorkPath} on its branch after verifying the issues.`);
