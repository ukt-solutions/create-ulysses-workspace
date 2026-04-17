# Team Lead Guide

You are setting up a workspace for your team. Maybe it is two developers, maybe ten. You want everyone working with the same conventions — consistent branching, shared context that does not get lost between sessions, and a release process that captures what shipped and why. This guide walks you through setting up the workspace and preparing it for your team.

---

## Step 1: Scaffold the Workspace

Create the workspace and initialize git:

```bash
npx create-ulysses-workspace --init team-workspace
cd team-workspace
git remote add origin git@github.com:team/team-workspace.git
```

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

Clone them:

```bash
git clone git@github.com:team/frontend.git repos/frontend
git clone git@github.com:team/backend.git repos/backend
git clone git@github.com:team/infrastructure.git repos/infrastructure
```

## Step 3: Set Up Team Knowledge

This is the most important step. Open `shared-context/locked/` and create files that capture what your team needs to know on every session.

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

Keep these files concise. The target for all of `shared-context/locked/` is under 10KB. These files are loaded on every turn for every team member and injected into every subagent. Concise means useful; verbose means expensive.

## Step 4: Activate Optional Rules

Review the rules in `.claude/rules/`. Six are active by default. Eight are available but deactivated (`.skip` extension):

```bash
ls .claude/rules/
```

For your team, you might activate:
- `scope-guard.md.skip` → `scope-guard.md` if scope creep is a recurring problem
- `documentation.md.skip` → `documentation.md` if you want Claude to maintain docs alongside code

Rename to activate, commit the change. The whole team gets the activated rule on their next pull.

## Step 5: Understand the Collaboration Model

Here is how shared context flows between team members:

**Locked context** is read by everyone, every session. It is the team's source of truth. Changes to locked context are committed to git and go through normal review.

**User-scoped context** (`shared-context/{user}/`) is where each person's working context lives. Braindumps, handoffs, session trackers. These are visible to the team (tracked in git) but belong to their author.

**Promotion** moves knowledge upward. When someone discovers something the team should know, `/promote` moves it from personal context to locked. When `/release` runs, it synthesizes ephemeral knowledge into locked entries.

The flow:

```
Individual work → user-scoped captures → promotion → locked team truths
                                                          ↓
                                       Team reads on every session
```

Team members do not need to coordinate shared context manually. Each person captures their own work. The promotion and release skills handle the synthesis.

## Step 6: Prepare for Your Team

Before your team clones the workspace, make sure:

1. **workspace.json has all repos** with correct remotes and default branches.
2. **Locked context has team truths** — at minimum, project status and key architectural decisions.
3. **Optional rules are activated** for your team's needs.
4. **Push the workspace** to the remote so your team can clone it.

```bash
git add -A
git commit -m "chore: initial workspace setup"
git push -u origin main
```

## Step 7: Onboard Your Team

Send your team the workspace repo URL and point them to the [New Team Member Guide](new-team-member.md). They will clone, run `/workspace-init`, and start working.

Each person gets their own user-scoped directory (`shared-context/{their-name}/`). Their work sessions are independent — no coordination needed for parallel work.

When it is time to release, `/release` combines everyone's branch notes into a unified version document.

## Where to Go Next

- [Chapter 3: Shared Context](../chapters/03-shared-context.md) — the full shared context model, promotion lifecycle, and ephemeral patterns
- [Chapter 5: Rules](../chapters/05-rules.md) — all rules explained, the .skip pattern, writing custom rules
- [Chapter 6: Skills](../chapters/06-skills.md) — every skill, when to use it, how they chain together
- [Chapter 9: The Release Cycle](../chapters/09-the-release-cycle.md) — how release notes flow and how ephemeral context gets cleaned up
