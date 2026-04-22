---
name: release
description: Prepend a new CHANGELOG.md entry per project repo by synthesizing unreleased branch notes. Deletes consumed branch notes and synthesizes workspace shared-context into locked entries. Use at release time.
---

# Release

Synthesize `release-notes/unreleased/branch-release-notes-*.md` into a concise, user-facing entry at the top of each project repo's `CHANGELOG.md`. Delete the consumed branch notes — they are an intermediate artifact, not long-term public record. In parallel, promote resolved workspace shared-context into locked team knowledge.

## Why this shape

Per-version release-notes files accumulate into a long tail of dogfood-retrospective docs that bloat public repos. A single `CHANGELOG.md` with one concise entry per version is what users of a published package actually want. Branch notes remain the input format for `/complete-work` (they capture per-session detail at the right moment), but they should not survive past `/release` in the public repo.

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
For each target repo:
```bash
ls repos/{repo}/release-notes/unreleased/
```
Read all `branch-release-notes-*.md` and `branch-release-questions-*.md` files.

If no unreleased files exist: "No unreleased notes found for {repo}. Nothing to release."

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

**Step 6: Delete consumed branch notes**
```bash
rm repos/{repo}/release-notes/unreleased/branch-release-*
```
The branch notes were an intermediate capture; their content is now in the CHANGELOG entry and their raw form in git history. No long-term archive is kept in the project repo.

**Step 7: Commit the release entry**
```bash
cd repos/{repo}
git add CHANGELOG.md release-notes/unreleased/
git commit -m "docs: v{version} changelog entry"
```

**Step 7b: Bump package.json version**
If the project repo has a `package.json` with a `version` field, update it to match the release version:
```bash
cd repos/{repo}
# Update "version": "..." in package.json to the release version
git add package.json
git commit -m "chore: bump version to v{version}"
```
Skip this step if the repo has no package.json or no version field.

**Step 8: Consume project-scoped specs**
Project-scoped specs and plans in `shared-context/{user}/` (ongoing) that are fully covered by this release:
- Consume into the CHANGELOG entry (their content is now captured there)
- Remove the source files
- If partially covered: rewrite the spec to reflect only what remains unimplemented

**Step 9: Synthesize workspace shared context**
Process ephemeral shared-context entries:

1. List all ephemeral entries with `lifecycle: resolved`
2. For each, determine:
   - Does an existing locked entry cover this topic? → Merge into it (enrich)
   - Are there related resolved entries? → Combine into a new locked entry
   - Is it stale/fully consumed by release notes? → Archive or delete
   - Is it unresolvable but still valuable? → Move to `{user}/` ongoing or keep as root ephemeral
3. For merged/new locked entries:
   - Set `state: locked`, `type: synthesized`
   - Move to `shared-context/locked/`
   - Write concise, focused content — team truths, not session history
4. Commit:
   ```bash
   git add shared-context/
   git commit -m "release: synthesize shared context for v{version}"
   ```

**Step 10: Report**
"Release v{version} complete for {repo}. {N} branch notes consumed into CHANGELOG.md. {M} context entries synthesized into {K} locked entries."

## Notes

- Release entries live in `CHANGELOG.md` at the project repo root — one file, one concise entry per version. No `release-notes/v*.md`, no `release-notes/archive/`.
- `release-notes/unreleased/` remains the intermediate capture zone for `/complete-work`. It is emptied every `/release` run.
- The public repo stays lean. Detailed per-branch retrospection exists in git history (commit messages, branch note content in the branch's commits) but is not surfaced as standalone long-term files.
- Context synthesis happens in the WORKSPACE repo — both get separate commits.
- Per-repo is the default — each repo has its own release cadence.
- The coherent-revisions rule applies: write the CHANGELOG entry from scratch, don't concatenate branch notes.
