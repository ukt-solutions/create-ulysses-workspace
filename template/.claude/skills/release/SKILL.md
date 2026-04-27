---
name: release
description: Prepend a new CHANGELOG.md entry per project repo by synthesizing unreleased branch notes. Deletes consumed branch notes and synthesizes workspace workspace-context into locked entries. Use at release time.
---

# Release

Synthesize unreleased branch notes (in the **workspace** repo) into a concise, user-facing entry at the top of each project repo's `CHANGELOG.md`. Delete the consumed branch notes from the workspace. Bump the project repo's `package.json` version. In parallel, promote resolved workspace workspace-context into locked team knowledge.

## Why this shape

Branch notes are detailed dogfood-retrospective artifacts that should not bloat public project repos. By keeping them in the workspace repo until release time, the project repo stays lean — it only ever sees code commits and `CHANGELOG.md` entries. A single `CHANGELOG.md` with one concise entry per version is what users of a published package actually want. Branch notes remain the input format for `/complete-work` (they capture per-session detail at the right moment), but they live in the workspace and are consumed-then-deleted by `/release`.

Versions are bumped here, not in `/complete-work`, because version semantics describe what shipped — accumulated changes since the last release — not the timing of any individual feature merge.

## Parameters
- `/release {version}` — create a release entry for a specific version
- `/release` — ask for the version

## Flow

**Step 1: Determine version and repo**
If no version parameter: ask "What version is this release? (e.g., 1.2.0)"

Check `workspace.json` for `releaseMode`:
- **per-repo** (default): ask which repo to release
- **workspace**: process all repos together
- **ask**: "Process all repos together or individually?"

**Step 2: Read unreleased notes**
Branch notes live in the **workspace** repo, written there by `/complete-work`. For each target repo, list the workspace's unreleased subdirectory for that project:
```bash
ls release-notes/unreleased/{repo}/
```
Read all `branch-release-notes-*.md` and `branch-release-questions-*.md` files.

If no unreleased files exist for a target repo: "No unreleased notes found for {repo}. Nothing to release."

The frontmatter `repo:` field on each branch-notes file confirms which project repo the notes belong to — match that to the directory name as a sanity check. Notes mismatched on `repo:` are a sign of manual file moves; surface to the user.

**Step 3: Group and organize**
Group notes by `type:` frontmatter (feature, fix, chore). Within each group, order chronologically by date. This ordering drives bullet sequence in the synthesized entry.

**Step 4: Handle questions**
Present all open questions from `branch-release-questions-*.md` files:
"These questions are still open from development. For each one:"
- **Answer** — provide the answer, remove from questions
- **Defer** — keep as a "Known issues" sub-bullet in the CHANGELOG entry
- **Discard** — no longer relevant

**Step 5: Synthesize the CHANGELOG entry**

Read the current `repos/{repo}/CHANGELOG.md` (if it exists) so the new entry matches the existing voice and structure. If no CHANGELOG exists, create one with a short header explaining that entries are written for package users, not contributors.

Prepend a new section at the top of the changelog body (after the header, before any existing version entries). Write it user-facing — what shipped, not how it shipped:

```markdown
## v{version} — {YYYY-MM-DD}

- {Concise bullet per meaningful change. Features, fixes, and chores interleaved
  by significance, not by category. Each bullet is one sentence or short paragraph
  in plain user-facing language: "the CLI now supports X", "corrected Y behavior
  on Z", not "we decided" or "the team merged." Deduplicate related items.
  Write from scratch per the coherent-revisions rule.}

### Known issues
- {Deferred questions from Step 4, if any. Omit this subsection when empty.}
```

The entry stays short. If a change needs more detail, reference the repo's docs or a dedicated design doc — do not inline session-level retrospection into the public changelog.

**Step 6: Delete consumed branch notes from the workspace**
```bash
rm release-notes/unreleased/{repo}/branch-release-*
# If the directory is now empty, remove it too:
rmdir release-notes/unreleased/{repo} 2>/dev/null || true
```
The branch notes were an intermediate capture; their content is now in the CHANGELOG entry and their raw form in git history. They do not survive into the project repo.

**Step 7: Commit the CHANGELOG entry to the project repo**
```bash
cd repos/{repo}
git add CHANGELOG.md
git commit -m "docs: v{version} changelog entry"
```
This commit lands on the project repo's source clone (which stays on its default branch). The user pushes it when ready — `/release` does not push automatically.

**Step 7b: Bump package.json version (project repo)**
If the project repo has a `package.json` with a `version` field, update it to match the release version:
```bash
cd repos/{repo}
# Update "version": "..." in package.json to the release version
git add package.json
git commit -m "chore: bump version to v{version}"
```
Skip this step if the repo has no package.json or no version field.

**Step 7c: Commit the consumed-notes deletion in the workspace**
```bash
# From the workspace root
git add release-notes/unreleased/
git commit -m "release: consume {repo} branch notes for v{version}"
```
Workspace and project repos have separate commits — they are separate git histories.

**Step 8: Consume project-scoped specs**
Project-scoped specs and plans in `workspace-context/{user}/` (ongoing) that are fully covered by this release:
- Consume into the CHANGELOG entry (their content is now captured there)
- Remove the source files
- If partially covered: rewrite the spec to reflect only what remains unimplemented

**Step 9: Synthesize workspace shared context**
Process ephemeral workspace-context entries:

1. List all ephemeral entries with `lifecycle: resolved`
2. For each, determine:
   - Does an existing locked entry cover this topic? → Merge into it (enrich)
   - Are there related resolved entries? → Combine into a new locked entry
   - Is it stale/fully consumed by release notes? → Archive or delete
   - Is it unresolvable but still valuable? → Move to `{user}/` ongoing or keep as root ephemeral
3. For merged/new locked entries:
   - Set `state: locked`, `type: synthesized`
   - Move to `workspace-context/shared/locked/`
   - Write concise, focused content — team truths, not session history
4. Commit:
   ```bash
   git add workspace-context/
   git commit -m "release: synthesize shared context for v{version}"
   ```

**Step 10: Report**
"Release v{version} complete for {repo}. {N} branch notes consumed into CHANGELOG.md. {M} context entries synthesized into {K} locked entries."

## Notes

- Release entries live in `CHANGELOG.md` at the project repo root — one file, one concise entry per version. No `release-notes/v*.md`, no `release-notes/archive/`.
- Branch notes live in the WORKSPACE at `release-notes/unreleased/{repo}/`. `/complete-work` writes them; `/release` consumes and deletes them. They never reach project repos.
- Versions are bumped here, not in `/complete-work`. This keeps the version semantics aligned with what actually shipped (accumulated changes since last release).
- The public repo stays lean. Detailed per-branch retrospection exists in workspace git history (the consumed-notes commit) but is not surfaced as standalone files in either repo.
- Context synthesis happens in the WORKSPACE repo — Step 7c (consumed-notes) and Step 9 (workspace-context synthesis) are separate workspace commits.
- Per-repo is the default — each project repo has its own release cadence.
- The coherent-revisions rule applies: write the CHANGELOG entry from scratch, don't concatenate branch notes.
