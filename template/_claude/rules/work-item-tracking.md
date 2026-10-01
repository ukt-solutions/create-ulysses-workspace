# Work Item Tracking

When a workspace has a tracker configured, **all work items — bugs, features, chores — live
in that tracker.** There is no local file mirroring its state. Skills reach it through
`createTracker()` from `.claude/scripts/trackers/interface.mjs`; that module is the source of
truth for the available methods, and the four skills that use it (`start-work`, `pause-work`,
`complete-work`, `setup-tracker`) each carry the exact calls they make.

## Why external-first

Two people can't start the same ticket — the tracker is the source of truth for who has what.
Status changes reach the whole team the moment they happen rather than after a push. And
humans and Claude read the same list in the same place.

## Configuration

`workspace.json` → `workspace.tracker`: `{ "type": "github-issues", "repo": "owner/name" }`.
`type` names the adapter at `.claude/scripts/trackers/{type}.mjs`; only `github-issues` ships.
`repo` is adapter-specific — for GitHub, the slug where issues live, or `"auto"` to resolve
from the git remote. No `workspace.tracker` means tracking is disabled, and skills fall back
to a blank describe-the-work flow rather than fabricating a local mirror.

## Session linkage

`/start-work` records the adapter-prefixed issue ID in session frontmatter as `workItem: gh:42`.
The prefix makes it self-describing across adapter swaps.

## When to create issues

- **Work described during `/start-work`** → create the issue, then claim it.
- **A bug or feature found mid-session** → ask "Create an issue for this? [Y/n]". Link it to
  the session if it is in scope; leave it unassigned if it is a future concern.
- **Never during braindumps or handoffs.** Those are discussion artifacts. Action items can
  graduate to issues later, at `/start-work`.

## What not to do

- Do not create, read, or write `workspace-context/open-work.md`. It is deprecated.
- Do not put ticket state in session frontmatter beyond the `workItem:` pointer. Status,
  assignment, labels and milestone live in the tracker.
- Do not cache issue bodies locally. Fetch with `tracker.getIssue(id)` when you need one.

## Boundaries

Adapter choice is per workspace; this rule prescribes no particular tracker. Beyond the six
labels `ensureLabels()` creates (`bug`, `feat`, `chore`, `P1`, `P2`, `P3`), it prescribes no
schema — teams with an existing tracker skip label creation. Tracker-native features like
comments, reactions and linked PRs stay in the tracker's own UI.
