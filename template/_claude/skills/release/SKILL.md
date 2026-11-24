---
name: release
description: Cut a versioned release of one project repo — bump the version, merge it through a PR, tag it, and publish a forge release whose notes are generated from merged PRs. No release-notes files.
---

# Release

Cut a versioned release of one project repo. The version bump travels through a PR like any other change; the tag marks the merge commit; the forge generates the release notes from merged PR titles. The workspace keeps no release-notes files of its own.

## Why this shape

Release notes come from the forge. GitHub's generated notes (merged PR titles) are what users of a published release actually read; the detail behind each PR already lives in the issue and the PR body, so duplicating it into workspace files buys nothing. Projects that use changesets, semantic-release, or their own release tooling simply don't use this skill. A repo's `CHANGELOG.md`, if it has one, is historical — this skill never writes it.

## Parameters

- `/release {version}` — release a specific version
- `/release` — ask for the version

## Flow

**Step 1: Determine version and repo**

Ask which repo to release — read `repos` from `workspace.json` and default to the entry with `"primary": true`. If no version was given, ask the bump kind (patch/minor/major) after showing the merged PRs since the last tag, so the operator can judge the impact:

```bash
git -C repos/{repo} describe --tags --abbrev=0        # v{previous}
git -C repos/{repo} log -1 --format=%cI v{previous}   # the previous tag's commit time
```

Then call the forge adapter's `prList` with `state: 'merged'`, `base:` the repo's default branch, and a merged-after search bounded by that tag's commit time — the full `%cI` timestamp (e.g. `merged:>2026-05-01T10:00:00Z`), never a bare date, which would sweep in every PR merged later the same day. `base` matters because PRs merged into other branches are not this release. If the returned list carries `truncated: true`, older PRs may sit beyond the fetched page — say so and re-query with a higher `limit` before judging the bump. Pre-v1.0 breaking changes are a minor bump.

**Step 2: Preflight the tag and the forge**

Two checks before anything is pushed. First the tag: if `v{version}` already exists on origin, stop and ask — reuse it, investigate with `forge.releaseView`, or pick another version. Never force-push a tag.

```bash
git -C repos/{repo} ls-remote --exit-code origin refs/tags/v{version}
```

Second the release path. Build the repo's forge with `forgeConfigForRepo(root, '{repo}', ws)` from `.claude/scripts/merge-mode.mjs` — it picks the adapter from the repo's own origin, so a GitLab repo gets the gitlab adapter whatever `workspace.forge` says — and decide now who creates the release (Step 6): the repo's CI, or this skill. If the flow needs something the forge cannot do, stop here — past this point the tag is pushed, and a publish that cannot run is much harder to unwind.

**Step 3: Bump on a branch**

Create a task worktree for the release branch:

```bash
node .claude/scripts/task-worktree.mjs --root . --create --repo "{repo}" --branch "release/v{version}"
```

If the repo has a `package.json` with a `version`, set it to `{version}` (edit the JSON; keep formatting) and update `package-lock.json`'s top-level version fields if that file is present. Commit `chore: release v{version}`. If the repo has no version file, skip the commit — step 6 tags the current default-branch head instead.

**Step 4: Merge**

Push the branch and open a PR through the same per-repo forge (`forgeConfigForRepo` from Step 2) with head `release/v{version}`. Ask `Merge? [Y/n]`, then merge (squash, delete branch).

**Step 5: Leak audit and consumer-facing review**

Pull the merge, then look at what is about to be tagged: a scripted pattern audit first, an advisory read of the consumer-facing prose second. The tag is the lock point — a published version cannot be taken back — so both run now, before it exists.

```bash
git -C repos/{repo} pull --ff-only
```

*5a — Pattern audit (optional).*

```bash
node .claude/scripts/release-leak-audit.mjs --root . --repo "{repo}"
```

Patterns live in `workspace.json` — `repos.{repo}.release.leakPatterns` for one repo, `workspace.release.leakPatterns` for every repo (the workspace repo `.` reads the workspace block) — as arrays of strings: `/…/flags` is that regex, anything else a case-insensitive literal. Mind the seam between the forms: a path-like literal whose tail parses as a flags run (`/keys/i`) reads as a regex — write such literals without the leading slash or escape them as a regex. A workspace can start from patterns like these, which are examples to adapt and not defaults — what counts as internal is specific to each workspace:

```json
"release": {
  "leakPatterns": [
    "/\\/Users\\/[^/\\s]+/",
    "local-only-",
    "workspace-scratchpad/",
    "/\\bgh:\\d+\\b/"
  ]
}
```

The script scans what this release publishes, as one union: the `npm pack --dry-run --ignore-scripts` file list of the root package when it is publishable and of every non-private npm workspace package (array or `{ packages }` form; exact directories and `packages/*`; build artifacts a publish workflow generates only in CI are not in npm's local list), the files changed since the last tag (`--tag-range <from>..<to>` overrides, reading contents from the range's end commit when it is not HEAD), and any paths named by `repos.{repo}.release.consumerFacing` / `workspace.release.consumerFacing` — repo-relative strings where a trailing `/` makes a directory prefix, for documents that ship whether or not they changed (`["docs/", "openapi.yaml"]`: an API spec, an error catalog). It also scans every commit message in the range, squash-merged PR bodies included. The worktree must be clean, since contents are read from disk (`--allow-dirty` overrides). Matched spans are masked in the excerpt, so showing a match never echoes the secret.

Exit 1 lists matches as `{ file, line, pattern, excerpt }`: stop and show them; never edit files to silence the audit. Either way `skipped` lists what the script could not read or enumerate — an unreadable file, a failed package pack, a `workspaces` entry it does not understand or a workspace directory without a readable `package.json`, a `consumerFacing` path that matched no file — and those places were not scanned, so show them too; it is informational and never changes the exit code. Exit 0 with `no leak patterns configured` is the no-patterns case — the step still runs and exits 0, so a workspace that never opts in needs no special-casing. Exit 2 means the audit itself could not run (including a dirty worktree); report that too. Whether a match is a true leak, an over-broad pattern, or a release to redo is the operator's call — cheap before the tag is pushed, impossible after.

*5b — Consumer-facing review (advisory).*

Patterns catch what a workspace can name in advance. They cannot catch prose that is fine as text and wrong as documentation: a README step that only the maintainers can perform, or a changelog line that points at an internal ticket. This review reads for that, once 5a is settled. It is on by default; set `repos.{repo}.release.consumerReview` or `workspace.release.consumerReview` to `false` to opt out (the repo's own setting wins; the workspace repo `.` reads the workspace block). When it is off, say so in one line and go on to Step 6.

1. List the consumer-facing prose — the README, CHANGELOG, CONTRIBUTING, SECURITY, UPGRADING and MIGRATION files, every `package.json`, and every `consumerFacing` path on the release surface:

   ```bash
   node .claude/scripts/release-leak-audit.mjs --root . --repo "{repo}" --list-consumer-facing
   ```

   The result is `{ mode, range, files: [{ path, changed }], skipped }`, and it needs no patterns configured. `changed` means changed since the last tag, except that a `package.json` counts only when something other than its `version` differs — the version bump made in Step 3 is not a prose change, so a release that touched nothing else is skipped below. Show a non-empty `skipped` — a package that could not be enumerated has not been reviewed.

2. If no file has `changed: true`, report "No consumer-facing prose changed since v{previous} — review skipped" and go on to Step 6.

3. Otherwise dispatch **one** `researcher` subagent (read-only). Give it the paths of the changed files, absolute under `repos/{repo}/` (the workspace root for `.`), and these five classes, then this instruction: "Report only passages a consumer of this published package would read and could not act on, or that expose internal detail. Return a list of `{ file, line, class, quote (≤ 120 chars), why }`. Return an empty list if nothing qualifies. Do not flag passages outside these classes."

   - **Operator procedure** — steps only the maintainers can perform, written as if the reader could. Flag: "Open the vendor console, go to Settings → Tokens, and mint a publish token before running the release." Not: "Create an API key under Settings → API keys, then pass it to the client."
   - **Internal infrastructure** — CI variable names, secret-store paths, private hosts, runbook or dashboard URLs. Flag: "The token lives in the `release-prod` vault at vault.corp.example/release." Not: "Set `API_KEY` in the environment; the client reads it at startup."
   - **Internal identifiers** — references into a tracker or branch scheme the consumer cannot open. Flag: "Behavior changed for PLAT-4417 (branch `feature/auth-rewrite`)." Not: "Fixed in #214" where #214 is an issue in the public repo.
   - **Cross-repo internal names** — private repositories, internal services, and packages that are not published. Flag: "Mirrors the retry logic in acme-billing-core (private)." Not: "Depends on `@acme/shared`," which is on the public registry.
   - **Local filesystem paths** — paths from a maintainer's machine. Flag: "Build output is copied from `C:\Users\jo\work\app\dist`." Not: "Config is read from `~/.config/app/` by default," a documented location on the consumer's machine.

4. Present the findings as one table. For each, the operator picks **fix**, **accept**, or **dismiss** (with a one-line reason):

   - **Fix** — the release PR is already merged, so the fix goes through its own PR. After it merges, `git pull --ff-only` and re-run Step 5 before tagging.
   - **Accept** and **dismiss** are recorded only in the Step 7 report, never in a file.

The review is advisory: it never blocks the release on its own and never edits a file. Its findings are a prompt for the operator's judgment, the way a match from 5a is.

**Step 6: Tag and publish**

Tag the merge and push the tag:

```bash
git -C repos/{repo} tag v{version}
git -C repos/{repo} push origin v{version}
```

Who creates the release depends on the repo, and the CI check is per-forge:

- **GitHub**: `.github/workflows/publish.yml` that itself creates the release (it contains `gh release create`, `softprops/action-gh-release`, or `actions/create-release`) owns the release — do not call `releaseCreate`; racing it duplicates the release or fails. Instead find and watch its run with `workflowRunFind` / `workflowRunWatch` — retry the find up to 5 times with 3 s backoff (the run may not be registered the moment the tag lands); a failed run is reported to the operator, not thrown.
- **GitLab**: `.gitlab-ci.yml` with a `release:` keyword block (a release-cli job) owns the release the same way — do not call `releaseCreate`; find and watch the tag's pipeline with `workflowRunFind({ workflow: 'ci.yml', branch: 'v{version}' })` / `workflowRunWatch` (the workflow name is ignored — one pipeline per ref).

Either way, confirm the release exists with `forge.releaseView({ tag: 'v{version}', repo })`.

Otherwise the skill creates the release itself — on GitHub the forge generates the notes; on GitLab it cannot (`NOT_SUPPORTED`), so the notes come from the same query Step 1 ran:

```js
// GitHub
await forge.releaseCreate({ tag: 'v{version}', repo, generateNotes: true });
// GitLab — notes come from the skill, not the forge. tagTime is the %cI of
// v{previous}; base excludes MRs merged into other branches.
const merged = await forge.prList({ state: 'merged', base: '{default branch}',
  search: `merged:>${tagTime}`, repo });
if (merged.truncated) warn('older MRs may be missing — raise limit and re-query');
await forge.releaseCreate({ tag: 'v{version}', repo, generateNotes: false,
  notes: merged.map((p) => `- ${p.title}`).join('\n') });
```

If a `publish.yml` (or a publish job) without release creation exists, still find and watch its run the same way.

**Step 7: Tear down and report**

Remove the release worktree:

```bash
node .claude/scripts/task-worktree.mjs --root . --remove --repo "{repo}" --branch "release/v{version}" --delete-branch
```

Report the PR, the tag, the release URL, the publish status, and the consumer-facing review: skipped, or N findings (fixed / accepted / dismissed).

**Step 8: Update workspace release state**

If the workspace keeps release state in `workspace-context/` (for example a current-release line in a status file under `shared/locked/`), offer to update it — through a workspace task worktree and PR, never on the launcher.

## Notes

- Never run `npm publish` locally. The publish workflow is the only path that exercises OIDC trusted publishing; a local publish requires a 2FA OTP and bypasses it. If the workflow fails, investigate via `gh run view` — do not fall back to a local publish.
- Recovery from a failed publish: transient failures rerun via `gh run rerun {run_id}`; content failures mean deleting the tag and redoing the release. Once a version is published to a registry, that version number is committed — bump and release a new version instead.
- Pre-v1.0 breaking changes are a minor bump, not major.
