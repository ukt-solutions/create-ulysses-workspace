# Team Lead Guide

You are setting up a workspace for your team. Maybe it is two developers, maybe ten. You want everyone working with the same conventions — consistent branching, shared context that does not get lost between sessions, and a release process that captures what shipped and why. This guide walks you through setting up the workspace and preparing it for your team.

---

## Step 1: Scaffold the Workspace

Create the workspace, then make it a git repository:

```bash
npx @ulysses-ai/create-workspace@beta --init team-workspace
cd team-workspace
git init
```

`--init` writes the workspace's files and stops there. It does not create a git repository, and it does not clone anything. The `git init` matters: `/workspace-init`, two steps from now, does all of its work on a branch.

## Step 2: Add Your Repos

Open `workspace.json` and add every repo your team works with:

```json
{
  "repos": {
    "frontend": {
      "remote": "git@github.com:team/frontend.git",
      "branch": "main"
    },
    "backend": {
      "remote": "git@github.com:team/backend.git",
      "branch": "develop"
    },
    "infrastructure": {
      "remote": "git@github.com:team/infrastructure.git",
      "branch": "main"
    }
  }
}
```

Notice that each repo declares its default branch. If your backend uses `develop` as the integration branch, set it here — skills will rebase against it and create PRs targeting it.

You can leave the cloning to the next step. If you would rather clone them yourself:

```bash
git clone git@github.com:team/frontend.git repos/frontend
git clone git@github.com:team/backend.git repos/backend
git clone git@github.com:team/infrastructure.git repos/infrastructure
```

## Step 3: Initialize

Open Claude Code at the workspace root and run the setup skill:

```bash
claude
```

```
/workspace-init
```

It runs the whole setup in one pass, on a `chore/workspace-init` branch:

- It offers to clone each repo in `workspace.json`. New work is always a task, so there is no lifecycle to choose.
- If you point it at documentation — Notion, Confluence, markdown — it extracts team knowledge from it, and from your earlier Claude chats, into `workspace-context/`.
- It installs the rest of the template, and asks which optional rules to activate.
- It configures your identity, and offers to start the team roster with you as its first entry.
- It offers to link an issue tracker, and creates the workspace's remote repository or connects one that already exists.
- It ends by offering to merge the init branch into the default branch, pushing it if the workspace repo has an `origin`.

[Chapter 10](../chapters/10-installation-and-upgrades.md) lists every step.

## Step 4: Set Up Team Knowledge

This is the most important step. `/workspace-init` created locked knowledge from whatever it could extract. Review what it wrote in `workspace-context/shared/locked/`, then add what your team needs to know on every session.

**Project status** — what the project is, what is built, what is next:

```markdown
---
state: locked
type: reference
topic: project-status
updated: 2026-04-06
---

# Project Status

## What It Is
A marketplace for local artisans. Frontend is Next.js, backend is Python/FastAPI, infra is AWS CDK.

## What's Built
User auth, product listings, search. Checkout is in progress.

## Current Focus
Shipping checkout flow by end of April.
```

**Architectural decisions** — the choices that affect daily work:

```markdown
---
state: locked
type: reference
topic: architecture
updated: 2026-04-06
---

# Architecture Decisions
- API is REST, not GraphQL. Decision made early, not revisiting.
- Auth uses JWT with refresh tokens. Session cookies were considered and rejected.
- All state is in PostgreSQL. No Redis cache yet — add when needed, not before.
```

Keep these files concise. The target for all of `workspace-context/shared/locked/` is under 10KB. These files are loaded on every turn for every team member and passed to every subagent. Concise means useful; verbose means expensive.

Claude does not read the folder directly. It reads a generated catalog, `workspace-context/canonical.md`, which CLAUDE.md imports. So after you edit the locked files by hand, regenerate the catalog and commit the result:

```bash
node .claude/scripts/build-workspace-context.mjs --write --root .
```

## Step 5: Review the Optional Rules

`/workspace-init` asked which optional rules to activate. To revisit that, look at what is in `.claude/rules/`:

```bash
ls .claude/rules/
```

The template ships eight active rules and nine optional ones, which sit deactivated with a `.skip` extension until someone renames them. For your team, you might activate:
- `scope-guard.md.skip` → `scope-guard.md` if scope creep is a recurring problem
- `documentation.md.skip` → `documentation.md` if you want Claude to maintain docs alongside code

Rename to activate, commit the change. The whole team gets the activated rule on their next pull. [Chapter 5](../chapters/05-rules.md) describes each one.

## Step 6: Understand the Collaboration Model

Here is how shared context flows between team members:

**Locked context** (`workspace-context/shared/locked/`) is read by everyone, every session. It is the team's source of truth. Changes to it are committed to git and go through normal review.

**Personal context** (`workspace-context/team-member/{user}/`) is where each person's working context lives: braindumps, handoffs, research. These are visible to the team (tracked in git, unless marked `local-only-`) but belong to their author.

**Promotion** moves knowledge upward. When someone discovers something the team should know, `/promote` assesses it and moves it into shared or locked context. Nothing is promoted automatically, and a release promotes nothing.

The flow:

```
Individual work → personal captures → /promote → locked team truths
                                                    ↓
                                 Team reads on every session
```

Team members do not need to coordinate shared context manually. Each person captures their own work, and promotes what deserves a wider audience.

## Step 7: Prepare for Your Team

Before your team clones the workspace, make sure:

1. **workspace.json has all repos** with correct remotes and default branches.
2. **Locked context has team truths** — at minimum, project status and key architectural decisions.
3. **The optional rules fit your team** — activated where your team needs them.
4. **The team roster has you in it** (`workspace.json` → `workspace.team`). `/workspace-init` offers to start it. Add teammates now if you already made a `team-member/` folder for one, say by extracting their context: `node .claude/scripts/team-roster.mjs --add <folder> --name "Their Name" --forge <login> --email <email> --root .`. The folder name is the key, so their machine joins as that name instead of making a second folder.
5. **Everything is committed** — the init branch was merged, and your later changes are on the default branch.

If `/workspace-init` did not push for you, push the workspace now so your team can clone it:

```bash
git add -A
git commit -m "chore: initial workspace setup"
git push -u origin main
```

## Step 8: Onboard Your Team

Send your team the workspace repo URL and point them to the [New Team Member Guide](new-team-member.md). They will clone, run `/workspace-init`, and start working.

Each person gets their own personal directory (`workspace-context/team-member/{their-name}/`), and adds themselves to the roster in their first change. Their work is independent — no coordination needed for parallel work.

When one person ends up with two folders anyway, list the second name in their entry's `aliases`. `/maintenance` then reports the split and merges the folders with `git mv`, so the history stays with the files: `node .claude/scripts/team-roster.mjs --merge-alias <alias> --apply --root .`. A teammate whose machine still uses the alias gets a session-start warning carrying the one command that switches it: `--set-user <name>`.

When it is time to release, `/release` cuts a versioned release of one repo: it bumps the version, merges the bump through a PR, tags it, and publishes a forge release whose notes are generated from the merged PRs.

## Where to Go Next

- [Chapter 3: Workspace Context](../chapters/03-workspace-context.md) — the three levels of `workspace-context/`, how each is loaded, and promotion
- [Chapter 5: Rules](../chapters/05-rules.md) — all rules explained, the .skip pattern, writing custom rules
- [Chapter 6: Skills](../chapters/06-skills.md) — every skill, when to use it, how they chain together
- [Chapter 9: The Release Cycle](../chapters/09-the-release-cycle.md) — how `/release` works and where release notes come from
