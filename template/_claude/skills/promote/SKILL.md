---
name: promote
description: Move personal auto-memory or local-only files into workspace-context. Use when you've discovered something valuable that the team should know.
---

# Promote

Promote personal knowledge into workspace-context. Assess all candidates, recommend actions, let the user decide with coded references. A promotion lands through a task worktree of the workspace repo and a PR of its own, never through a commit at the workspace root, which stays on its default branch.

## Sources

This skill can promote from three sources:
1. **Auto-memory (AM)** — files in `~/.claude/projects/*/memory/`
2. **Local-only context (LOC)** — `workspace-context/team-member/{user}/local-only-*.md` (and any other `local-only-*.md` under `workspace-context/`)
3. **Local-only rules (LOR)** — `.claude/rules/local-only-*.md`

## Flow

**Step 1: List all candidates**

Show ALL candidates from all sources in a single coded table. The user should see everything at once to make informed decisions.

```
| Code | File                          | Assessment                              | Recommendation    |
|------|-------------------------------|-----------------------------------------|-------------------|
| AM1  | feedback_no_injection_rev...  | Redundant — coherent-revisions rule     | Drop from memory  |
| AM2  | project_create_claude_work... | Stale — references deleted spec         | Drop or update    |
| AM3  | feedback_subagent_perms...    | Personal setup quirk                    | Keep as memory    |
| LOC1 | local-only-naming-ideas.md    | Team should see naming options          | Promote to alice/ |
| LOC2 | local-only-release-checkli... | Personal task tracker                   | Keep local        |
| LOR1 | local-only-dogfood-sync.md    | Dogfood-specific, not for template      | Keep local        |
```

For each candidate, assess:
- Is it redundant with an existing rule or context file? → recommend drop
- Is it stale or outdated? → recommend drop or update
- Is it personal/setup-specific? → recommend keep as-is
- Would the team benefit from seeing it? → recommend promote

**Step 2: User decides**

The user responds using codes:
- "Promote: LOC1, LOC2. Drop: AM1, AM2. Keep the rest."
- "Promote all LOC. Drop AM1-AM3."
- Or any combination.

**Step 3: Execute decisions**

Command values go in single quotes, and a `'` inside a value is written `'\''`: chat text in double quotes would let `$(…)` or backticks run before the command starts.

Every command in this step is anchored at the workspace root with `{launcher-root}`, the absolute path on the `Workspace root:` line the SessionStart hook injects. A chat inside a session's worktree gets `Working in workspace worktree. Main root: …` instead; that path is the launcher. Sources and scratch files live there, wherever the chat runs.

For each **drop** action:
- Delete the file (auto-memory from `~/.claude/projects/*/memory/`, local-only from workspace)
- Update MEMORY.md index if auto-memory was removed

For each **keep** action:
- No changes

For the **promote** actions, all of them together: the workspace root is the launcher and stays on the repo's default branch, so a promoted file is never written or committed there. It goes into one task worktree of the workspace repo and lands through one PR.

1. **Create the worktree.** `{name}` is the promoted file's topic, or one kebab-case name when several files are promoted together. The `path` in the output is `{worktree}`:
   ```bash
   node '{launcher-root}/.claude/scripts/task-worktree.mjs' --root '{launcher-root}' --create --repo . --branch 'chore/promote-{name}'
   ```
2. **Ask the level** of each file: team-visible (`workspace-context/shared/`), user-scoped (default, `workspace-context/team-member/{user}/`), or locked (`workspace-context/shared/locked/`).
3. **Write each destination inside the worktree.** Read each source where it is: a gitignored `local-only-*` file exists only at the launcher, never inside the worktree, and auto-memory is outside the workspace.
   ```bash
   cat '{source-file}' | node '{launcher-root}/.claude/scripts/capture-context.mjs' \
     --root '{worktree}' \
     --type {braindump|handoff|research} \
     --topic '{kebab-name}' \
     --scope {team-member|shared} \
     [--user {workspace.user}] \
     --update
   ```
   For locked the helper is not involved: write the file to `{worktree}/workspace-context/shared/locked/{bare-name}.md`. Locked files use bare names, because location signals the type, and take no prefix, so strip the `braindump_`, `handoff_` or `research_` prefix.
4. **Mark each destination `type: promoted`.** The helper writes the standard frontmatter; edit `type` afterward, in the worktree.
5. **Regenerate the catalogs, then commit inside the worktree.** The commit runs against the worktree with `-C`: from the workspace root, `git add` cannot reach a path under `.claude/worktrees/`, which the launcher's `.gitignore` covers.
   ```bash
   node '{launcher-root}/.claude/scripts/build-workspace-context.mjs' --write --root '{worktree}'
   git -C '{worktree}' add workspace-context/
   git -C '{worktree}' commit -m 'promote: {name}'
   ```
6. **Open the PR.** Write its body first to `{launcher-root}/workspace-scratchpad/promote-pr-{name}.md`: one line per promoted file, naming its source and where it landed, with why it was promoted. The scratchpad is gitignored, so the body never touches a branch.
   ```bash
   node '{launcher-root}/.claude/scripts/task-pr.mjs' --create --root '{launcher-root}' --branch 'chore/promote-{name}' \
     --repo . --body-file '.={launcher-root}/workspace-scratchpad/promote-pr-{name}.md' \
     --out '{launcher-root}/workspace-scratchpad/promote-prs-{name}.json'
   ```
   The PR's title is the commit's subject. A workspace repo with no origin, or with `merge: "local"` in `workspace.json`, gets no PR: nothing is pushed, and the entry is only recorded for the merge in step 7. If the output lists `.` under `empty`, nothing was committed and there is nothing to promote: go to step 9. If `--create` refuses (forge operations are disabled by `workspace.forge: false`, or the origin is neither forge-hosted nor opted out with `merge: "local"`), report the message and leave everything in place. After any other failure, fix the cause and re-run the same command: it reuses what already landed and never duplicates a PR.
7. **Read the checks, then ask before merging, as the workspace's `mergeApproval` says.** The `--create` output carries it on the entry: `workspace.mergeApproval` in `workspace.json`, `ask` when unset.
   ```bash
   node '{launcher-root}/.claude/scripts/task-pr.mjs' --checks --root '{launcher-root}' --prs '{launcher-root}/workspace-scratchpad/promote-prs-{name}.json'
   ```
   Show the PR's link and check state; a local entry reports `none`.
   - `ask` (the default): ask once: "Merge `promote: {name}` into the workspace's default branch? [Y/n]", or "Merge it locally?" when the entry is local. Only an explicit yes merges.
   - `operator`: do not ask and do not merge. Report the link and check state and stop; the PR waits until the operator says merge in a later turn, or merges it in the forge UI.

   On yes, or on the operator's later go (add `--approved`), merge:
   ```bash
   node '{launcher-root}/.claude/scripts/task-pr.mjs' --merge --root '{launcher-root}' --prs '{launcher-root}/workspace-scratchpad/promote-prs-{name}.json'
   ```
   `--merge` reads every check before the first merge and stops if one is failing or still pending; pass `--wait` to poll. It merges the PR and pulls the workspace root `--ff-only`, so the promoted files arrive there. A local entry is fast-forwarded into the root instead, which must sit clean on its default branch for that. If the output reports `pullFailed`, or a `pullSkipped` other than `workspace merged locally`, the root does not have the files yet: pull it by hand before step 8.
8. **After the merge, offer to delete each `local-only-*` source**: "Remove the local-only originals now that they are tracked? [Y/n]". Delete them only on a yes.
9. **Tear down the worktree and its branch**, once the merge has succeeded:
   ```bash
   node '{launcher-root}/.claude/scripts/task-worktree.mjs' --remove --root '{launcher-root}' --repo . --branch 'chore/promote-{name}' --delete-branch
   ```
   Then delete the two scratch files. If the merge did not happen (the user said no, a check failed, or `operator` holds the PR), leave the worktree, the branch, the PR and every source exactly as they are, and say so. Step 7's merge command and this one finish the job later. `--delete-branch` is passed only here, after a merge. Never pass `--force` without asking.

**Step 4: Report**

"Promoted {N} files. Dropped {M} files. {K} files unchanged." Then say where the promotion stands: merged and in the workspace root, merged but awaiting a pull, PR open with its link and check state, or waiting for the operator.

## Rewrite on Promote

Auto-memory files are terse notes written for Claude's internal use. When promoting to workspace-context, rewrite into proper format with:
- Frontmatter (state, lifecycle, type: promoted, topic, author, updated)
- Sections with enough context to be useful to someone who wasn't in the original session
- Local-only files may already be well-formatted — copy as-is if so, just update frontmatter

## Notes
- Promotion is one-way: workspace-context should not be demoted back to local-only
- Use this when you discover a pattern, convention, or decision that would benefit the team
- The coded table makes bulk decisions fast — no need to type full filenames
- Assess everything upfront so the user sees the full picture before deciding
