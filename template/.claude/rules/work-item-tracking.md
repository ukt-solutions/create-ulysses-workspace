# Work Item Tracking

When a workspace has an issue tracker configured, all work items — bugs, features, chores — live in that tracker. Skills and scripts read and write the tracker through the adapter at `.claude/scripts/trackers/{type}.mjs`. There is no local file that mirrors the tracker's state.

## Why external-first

- **Atomic assignment.** Two teammates can't accidentally start the same ticket — the tracker is the source of truth for "who has this."
- **Real-time state.** Status changes propagate to the whole team the moment they happen, not after a commit + push.
- **Tool parity.** Humans and Claude see the same list of tickets in the same place.

## Configuration

`workspace.json` → `workspace.tracker`:

```json
{
  "workspace": {
    "tracker": {
      "type": "github-issues",
      "repo": "ukt-solutions/ulysses-workspace"
    }
  }
}
```

- `type` — identifies the adapter module at `.claude/scripts/trackers/{type}.mjs`. Only `github-issues` ships in the template; others are additive.
- `repo` — adapter-specific. For `github-issues`, the owner/name slug of the repo where issues live. `"auto"` resolves to the workspace's own git remote.

Absence of `workspace.tracker` means tracking is disabled. Skills handle this by falling back to a blank/describe-the-work flow — they do not fabricate a local mirror.

## Adapter interface (for Claude)

Import from `.claude/scripts/trackers/interface.mjs`:

```javascript
import { createTracker, AlreadyAssignedError } from '.claude/scripts/trackers/interface.mjs';

const tracker = createTracker(workspace.tracker);

const mine = await tracker.listAssignedToMe();        // Issue[]
const open = await tracker.listUnassigned();          // Issue[]
const issue = await tracker.claim('gh:42');           // throws AlreadyAssignedError on contention
const created = await tracker.createIssue({ title, body, labels: ['feat', 'P2'], milestone: 'Backlog' });
await tracker.comment('gh:42', 'paused here; see branch X');
await tracker.closeIssue('gh:42', { comment: 'shipped in PR #99' });
```

All skills that touch work items use this interface. Adapters are not called directly.

## Session linkage

When `/start-work` links a session to a tracker issue, the session tracker's frontmatter gets:

```yaml
workItem: gh:42
```

The value is the adapter-prefixed issue ID. This survives adapter swaps — replacing the GitHub adapter with a Linear adapter later doesn't require re-linking session trackers (though the prefix changes for *new* sessions).

## When to create issues

- **User describes new work during `/start-work`** → skill calls `createIssue` after session creation.
- **Bug or feature discovered mid-session** → Claude proactively asks "Create an issue for this? [Y/n]"; if yes, calls `createIssue` and links the session (if it's scoped to this session) or leaves it unassigned (if it's a future concern).
- **Never during braindumps or handoffs** — those are discussion artifacts, not work items. Action items can later graduate to issues during `/start-work`.

## When NOT to maintain local state

- Do not create, write to, or read `shared-context/open-work.md`. That file is deprecated.
- Do not write ticket state into `session.md` frontmatter beyond the `workItem:` pointer. Status, assignment, milestone, and labels live in the tracker.
- Do not cache issue bodies locally. Always fetch via `tracker.getIssue(id)` when the content is needed.

## Skill behavior

Skills that interact with the tracker:

- **`/setup-tracker`** — configures `workspace.json` → `tracker` block, calls `ensureLabels()`.
- **`/start-work`** — fetches assigned-to-me first; falls back to unassigned; claims atomically on pick. Records `workItem:` in session tracker.
- **`/pause-work`** — comments the pause capture on the linked issue.
- **`/complete-work`** — closes the linked issue after PRs merge, with a final comment linking them.
- **`/workspace-init`** — prompts to run `/setup-tracker` at the end of init. Does not pre-populate tickets.

## What this rule does NOT do

- Does not prescribe a specific tracker type. Adapter choice is per workspace.
- Does not prescribe label or milestone schemas beyond the six standard labels (`bug`, `feat`, `chore`, `P1`, `P2`, `P3`) created by `ensureLabels()`. Teams with existing trackers can skip label creation during setup.
- Does not replace tracker-native features (comments, reactions, linked PRs) — use the tracker's UI for those.
