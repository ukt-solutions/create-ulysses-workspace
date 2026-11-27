# Versioning

This document defines what the version number of `@ulysses-ai/create-workspace` promises. It is for two readers: people who install and upgrade workspaces, and contributors deciding how to bump the version after a change.

## What is versioned

The version tracks the template, not the CLI. The template is the product. It is everything that lands in a workspace: `.claude/` with its rules, skills, hooks, scripts and agents, `workspace.json`, `CLAUDE.md`, the layout of `workspace-context/` and the rest. The CLI (`bin/`, `lib/`) is only how the template gets there. A release is judged by what it does to a workspace that upgrades to it, and a change confined to the CLI counts only through its effect on that workspace.

A workspace upgrades in two steps:

```bash
npx @ulysses-ai/create-workspace@<tag> --upgrade
```

Then someone opens Claude Code in the workspace and runs `/workspace-update`. The command stages the new template under `.workspace-update/` and installs the current copy of the `/workspace-update` skill. It applies nothing else. The skill applies the staged template with the operator's confirmation, merging or asking about files the workspace has edited instead of overwriting them, and verifies the result with a scripted audit. [Installation and Upgrades](docs/chapters/10-installation-and-upgrades.md) describes the flow.

Version numbers are assigned at release time from what shipped. They are not planned in advance: work expected to be a minor can turn out to be a patch if the change was small.

## The public contract

The public contract is what a workspace may rely on.

### Skills

The slash commands, each a directory under `.claude/skills/`: `/aside`, `/braindump`, `/build-docs-site`, `/complete-work`, `/context-placement`, `/goal-driven-work`, `/handoff`, `/maintenance`, `/migrate-sessions`, `/promote`, `/release`, `/setup-tracker`, `/start-work`, `/workspace-init`, `/workspace-update`.

The name is the contract. The wording of a skill is not.

### Rules

The file names under `.claude/rules/`. Active: `coherent-revisions.md`, `forge-operations.md`, `git-conventions.md`, `goal-driven-work.md`, `honest-pushback.md`, `memory-guidance.md`, `work-item-tracking.md`, `workspace-structure.md`.

Optional, shipped as `.md.skip`: `agent-rules`, `cloud-infrastructure`, `config-review`, `documentation`, `local-dev-environment`, `product-integrity`, `scope-guard`, `superpowers-workflow`, `token-economics`. A workspace activates one by renaming it to `.md`, and an update leaves an activated rule active.

The file name is the contract. The wording of a rule is not.

### Hooks

What the shipped `.claude/settings.json` registers, by Claude Code event:

| Event | Hooks under `.claude/hooks/` |
|---|---|
| `SessionStart` | `workspace-update-check.mjs`, `session-start.mjs`, `version-freshness-check.mjs` |
| `SubagentStart` | `subagent-start.mjs` |
| `PreCompact` | `pre-compact.mjs` |
| `PostCompact` | `post-compact.mjs` |
| `PreToolUse` | `workspace-update-check.mjs`, `repo-write-detection.mjs`, `bash-output-advisory.mjs` |
| `SessionEnd` | `session-end.mjs` |

The contract is that each of these hooks is registered on its event.

### Scripts

Most of `.claude/scripts/` is called by skills. A skill and the scripts it calls change together, and a workspace is not expected to call them, so they are not on this list even where a documentation chapter shows their command line. The migrators are in that group too, including the ones a chapter shows being run by hand.

The scripts documented for people to run themselves are the contract, by name and by the flags their headers and `docs/` give them:

| Script | Flags |
|---|---|
| `team-roster.mjs` | `--suggest`, `--whoami`, `--check`, `--add <folder>`, `--set-user <name>`, `--merge-alias <alias>`, `--root <dir>`, `--offline`, `--name`, `--forge`, `--email`, `--alias`, `--detect`, `--new`, `--apply` |
| `generate-claude-local.mjs` | `--root <path>`, `--force` |
| `context-footprint.mjs` | `--root <dir>`, `--json`, `--budget <bytes>`, `--add <bytes>`, `--as <destination>` |

`team-roster.mjs` takes one command at a time. `--name`, `--forge`, `--email`, `--alias` and `--detect` belong to `--add`, `--new` to `--set-user`, and `--apply` to `--merge-alias`, which is a dry run without it.

### `workspace.json`

The fields under `workspace`, and what they mean. An absent field behaves as its default.

| Field | Meaning |
|---|---|
| `name` | The workspace's name, shown at session start. |
| `templateVersion` | The template version the workspace is on. Scaffolding sets it and `/workspace-update` advances it. |
| `initialized` | `true` once `/workspace-init` has finished. `/workspace-update` requires it. |
| `sessionModel` | No longer shipped, and read by nothing. New work is always a task. An older workspace keeps whatever it holds, because a field is never removed. |
| `tracker` | The issue tracker, or `null` for none. `type` is `github-issues` or `gitlab-issues`. `repo` is the slug, or `"auto"` to take it from the git remote. `host` names a self-managed GitLab. `epics: "native"` selects GitLab group epics, and absent means label mode. `epicLabelPrefix` defaults to `epic:`. |
| `forge` | The code host for pull requests and releases. `type` is `github` or `gitlab`, and with no `type` the host is read from each repo's origin. `repo` and `host` read as they do in `tracker`. `false` turns forge operations off. |
| `merge` | `"local"` finishes tasks for the workspace repo without pushing or opening a PR. |
| `mergeApproval` | `"ask"`, the default, merges after one question. `"operator"` stops before the merge and leaves it to a person. |
| `repoRemotes` | Whether each project clone is registered on the workspace repo as a `repo-{name}` remote, so Claude Code Desktop can match a pull request in that project to a chat at the workspace root. `true` unless it is `false`. `false` removes the remotes the script added and the hand-made ones it adopted, and leaves every other remote alone. |
| `release` | Settings for `/release`. `leakPatterns` are the patterns the release audit stops on. `consumerFacing` lists paths that ship whether or not they changed. `consumerReview: false` turns the advisory read of consumer-facing prose off. |
| `team` | The team roster, keyed by folder name under `workspace-context/team-member/`. An entry may carry `name`, `forge`, `gitEmails` and `aliases`. |
| `versionCheck` | `ambient` sets whether a session start checks npm for a newer template. It is `true` by default today. A comment in the hook that reads it says the default will flip to `false` at v1.0, so 1.0.0 is planned to change it. That is recorded here so the current default is not read as a promise. |
| `alwaysLoadedBudgetBytes` | Budget for everything read at launch: `CLAUDE.md`, its imports and the active rules. The template ships `65536`. A workspace without the field has no budget. |
| `canonicalBudgetBytes` | Budget for `workspace-context/canonical.md` alone. Off unless it holds a number. |
| `subagentInlineMaxBytes` | Locked files up to this size are inlined into a subagent's context. Larger ones become pointers. |
| `subagentContextMaxBytes` | The ceiling on what a subagent receives in all. Past it, the largest inlined files become pointers, largest first. |
| `greeting` | Shipped by the template and read by nothing, so it has no effect. It may be removed before 1.0.0. |
| `scratchpadDir`, `workspaceContextDir` | Where the scratchpad and workspace context live: `workspace-scratchpad` and `workspace-context` by default. |
| `workSessionsDir` | No longer shipped. It named the sessions directory of the session lifecycle, `work-sessions` by default, and is still read by the one thing that counts leftover sessions, so an older workspace's own value keeps pointing there. |

`repos` has one entry per project repository, keyed by its directory under `repos/`. An entry carries `remote` and `branch`, the default branch that worktrees start from and PRs target (`main` when absent). It may also carry `primary: true`, which makes it the repo that `/start-work` and `/release` default to, and `merge`, `mergeApproval` and `release`, which mean what they mean under `workspace` but for that repository alone.

`workspace.user`, the name of the person using this machine, is not in this file. It lives in `.claude/settings.local.json`, which is gitignored.

Two keys are left over from earlier versions: `localFiles` and `templateModifications`. They are still read, and `/workspace-update` offers to move them into `.claude/template-modifications.json`.

### CLI

Three forms, and one flag, are the contract:

| Form | What it does |
|---|---|
| No flag, as in `npm create @ulysses-ai/workspace@<tag>` | Scaffolds a workspace by prompt. It asks for the name, the directory, the repos to register, a user name and which optional rules to activate, then initialises the git repo and clones the repos. It writes into an empty directory only, one that does not exist yet or holds nothing but `.git`, `.DS_Store` or `Thumbs.db`, and refuses any other before writing anything, naming `--init` as the form for a directory that already has files. |
| `--init [dir]` | Scaffolds a new workspace without prompts. With no `dir`, the current directory becomes the workspace. |
| `--upgrade [dir]` | Stages a template update for an existing workspace. With no `dir`, the current directory is used. It refuses to stage a template older than the workspace's `templateVersion`. |
| `--upgrade --allow-downgrade` | Stages the older template anyway. |

`--migrate` is not part of the contract. It is deprecated, and the CLI exits with an error that points to `--init` or `--upgrade`.

### Directory layout

- `workspace-context/` and its three levels: `shared/locked/` for canonical team truths, which every session loads through `canonical.md`; `shared/` for team-visible working documents; `team-member/{user}/` for one person's context.
- `repos/{repo}/`, the source clones, each kept on its default branch.
- Worktrees. A task keeps a project repo's worktree at `repos/{repo}/.claude/worktrees/{slug}/` and the workspace repo's own at `.claude/worktrees/{slug}/`. `{slug}` is the branch name with `/` replaced by `-`. A workspace upgraded from an earlier version may still hold worktrees at `work-sessions/{name}/workspace/`, left over from the session lifecycle. The template leaves them alone until `/migrate-sessions` drains them.

### `.claude/template-modifications.json`

The workspace's own record of how it departs from the template. The template never ships this file and never overwrites it.

```json
{
  "localFiles": ["skills/my-skill/**"],
  "modifications": {
    "rules/git-conventions.md": "our trunk-based flow has no long-lived branches"
  }
}
```

Paths are relative to `.claude/`. `localFiles` lists files the workspace owns outright, as exact paths or `**` globs. `modifications` maps a template file the workspace has deliberately edited to the reason it is kept.

### Lifecycles

One lifecycle starts work: **task**. Every piece of new work is a task, whatever `workspace.json` holds. The **session** lifecycle is removed: `/start-work` neither starts nor resumes a session, and no other skill completes one. A workspace that still holds sessions from it drains them with `/migrate-sessions`, which finishes each through the task lifecycle's pull-request script, archives it, or, for an empty orphan shell, removes it. `workspace.sessionModel` remains a field because fields are never removed. It selects nothing.

## Major (breaking)

A major version is one where an existing workspace needs a manual step or a behaviour change to keep working after `--upgrade` and `/workspace-update`. A manual step is anything a person has to do beyond running those two and answering the update's own prompts: edit a file, move content, change a setting. A behaviour change is a change to something on the contract list above: a workspace can no longer rely on it working as documented. The internals of a skill or hook, and the wording of anything, can change in any release.

Changes that are breaking:

- A skill is removed or renamed. A migration can move files, but it cannot help someone who types a command that is no longer there, so this is always breaking unless the old name keeps working as an alias for at least one minor release.
- A rule, hook or listed script is removed or renamed.
- A `workspace.json` field is removed or renamed, or its meaning changes, or its default changes in a way that changes behaviour.
- A CLI flag is removed or renamed, or the interactive form is removed.
- A lifecycle is removed.
- The directory layout changes in a way that existing content has to move for.
- The minimum Node version goes up. It is `>=20.9.0` today, from `engines` in `package.json`.

Every item but the first is minor instead when the release ships an automatic migration for it, as defined under Minor.

## Minor

- A new skill, rule, hook or listed script.
- A new optional `workspace.json` field whose default keeps the current behaviour.
- A new CLI flag.
- A new lifecycle or option.
- A change that ships with an automatic migration the upgrade runs, so that no manual step is needed.

The last item is the one to be precise about. A migration counts as automatic only when `/workspace-update` itself runs it, with no separate skill invocation and no operator decision beyond answering the update's own prompts. An automatic migration is not breaking.

The update runs two idempotent migrators on every update. The rest are one-shot and version-gated, and it runs those inline when the workspace's previous version predates the step each was written for, with two exceptions. `migrate-sessions.mjs` is driven by the `/migrate-sessions` skill, which the update only suggests. `migrate-open-work.mjs` runs only when the user asks for it. A change that relies on `/migrate-sessions` or on any other separate step is breaking. A directory rename shows the difference: minor when a migrator does the move as part of the update, major when workspaces have to move their content by hand.

## Patch

Fixes that leave the contract as documented, and corrections to documentation and wording.

## Before 1.0

Before 1.0.0 a breaking change rides on a minor bump (`0.X.0`), not a major, so that the version number does not imply a stability that does not exist yet. The Major list still describes what such a release does to a workspace. Because the number will not carry the warning, the warning goes in the release notes, which are generated from merged PR titles, so a PR that makes a pre-1.0 breaking change has to say so in its title. After 1.0.0 the rules above apply as written.

## Pre-releases and dist-tags

The publish workflow maps the git tag to an npm dist-tag with [`scripts/dist-tag.mjs`](scripts/dist-tag.mjs):

| Tag | Dist-tag | Notes |
|---|---|---|
| `vX.Y.Z` | `latest` | stable |
| `vX.Y.Z-beta.N` | `beta` | where all pre-1.0 releases ship |
| `vX.Y.Z-rc.N` | `rc` | release candidates for a stable version |
| `vX.Y.Z-canary.N` | `canary` | no defined use in this project yet |
| `vX.Y.Z-next.N` | `next` | no defined use in this project yet |

Any other suffix fails the publish before anything is published. `-alpha.1` is rejected, and so is `-rc` with no number. The leading `v` is optional, no number may have a leading zero, and the tag has to match `version` in `package.json`.

`latest` is what a bare `npx @ulysses-ai/create-workspace` installs. Until 1.0.0, `latest` is not maintained and may point to an older beta, so install with `@beta`. An installed workspace reads its channel from its own version (`1.0.0-rc.2` is on `rc`) and checks for a newer template against its own channel's dist-tag and `latest`, taking the higher of the two. That is why each pre-release publishes under its own identifier.

The path to 1.0 is betas, then `1.0.0-rc.N` under `rc`, then `1.0.0` on `latest`.

## Deprecation (after 1.0)

Something on the contract that is going to be removed is deprecated first. It keeps working, and a minor release announces that it will go. It is removed only in the next major. The announcement is the release notes of that minor release. They are the GitHub release the publish workflow generates from merged PR titles, so the PR that deprecates something has to name the deprecation in its title.

Where the tooling can detect that a workspace still uses a deprecated thing, `/maintenance` or `/workspace-update` should say so. No general mechanism for that exists yet. Until one does, the release notes are the only notice, and a workspace that skips releases has to read back.

## What 1.0 does not promise

A 1.0 release makes the contract above stable. It does not promise:

- The output of internal scripts. Their JSON and text are for the skills that call them.
- The exact wording of skills and rules.
- Anything under the package's `lib/`, which holds the CLI's own modules, or the internals of the workspace's `.claude/lib/`, which holds helpers shared by hooks and scripts.
- Tests. The package's tests and the template's tests are both kept out of what is published.
- Behaviour that depends on Claude Code itself. If a Claude Code change forces an adjustment, the fix is versioned by its effect on workspaces, with the rules above.

## Local modifications

A workspace's own edits to template files are not part of the contract, and an upgrade does not discard them. `/workspace-update` merges a file the workspace has edited three ways: the workspace's version, the new template, and the template the workspace is upgrading from as the common ancestor. It asks about each such file when the older template could not be fetched, and about each file whose edit conflicts with the template's change. `.claude/settings.json` and `.mcp.json` are merged key by key, so a hook, server or setting the workspace added stays.

The registry is the other half. It keeps the workspace's own files out of the update entirely and carries the reason for each deliberate edit into every decision about that file. A change that only conflicts with local edits is not breaking. It still belongs in the release notes, naming the files, because those are the ones workspaces will be asked about.
