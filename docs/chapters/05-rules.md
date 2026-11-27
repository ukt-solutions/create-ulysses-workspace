# Rules

Rules are behavioral constraints that Claude follows on every turn. They are markdown files in `.claude/rules/` that define how Claude should approach work — how to handle git, how to write revisions, how to push back on bad ideas, how to manage memory. Rules are loaded automatically alongside CLAUDE.md, making them part of the always-on context.

This chapter covers the active and optional rules, the .skip activation pattern, and how to write your own.

---

## What Rules Do

A rule is a markdown file that gives Claude standing instructions. Unlike skills, which are invoked on demand for specific workflows, rules apply to every interaction. They shape Claude's default behavior — how it commits code, how it revises documents, how it decides what to remember.

Rules live in `.claude/rules/` and are tracked in git. Every `.md` file in this directory is loaded on every turn — unless it declares `paths:` frontmatter, which defers loading until a matching file is touched (see "Path-Scoped Rules" below). This means the team shares the same behavioral constraints, and changes to rules are versioned and reviewable like any other code change.

The template ships seventeen rules: eight active, one of which is path-scoped, and nine optional.

## Active Rules

Seven rules ship active and load on every turn. These encode the core conventions that make the workspace function correctly:

**coherent-revisions.md** — When revising any document or code, rewrite the affected section from start to finish so the result reads as a single coherent piece. Never patch or inject content between existing blocks. This applies to everything: docs, specs, code, context files, release notes, commit messages. The rule exists because injected revisions create fragmented output where the seams between old and new content are visible.

**git-conventions.md** — Branch naming (`feature/`, `bugfix/`, `chore/` prefixes, kebab-case), the worktree layout (a task's under `repos/{repo}/.claude/worktrees/{slug}/`, or `.claude/worktrees/{slug}/` for the workspace repo itself), conventional commit format (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`), and commit discipline: fetch and rebase before a pull request, never auto-resolve a conflict, and never amend or force-push unless asked. These conventions keep git history clean and work state predictable.

**honest-pushback.md** — Three sections that enforce intellectual honesty. First, Claude must challenge assumptions and push back when something seems wrong — no sycophantic agreement. Second, "No Retry Loops" — if a fix fails twice with the same result, stop and research before trying again. Third, "Verify, Don't Assume" — when evidence is available (logs, database, UI, API responses), check it instead of guessing. Claude asks once whether to verify proactively, then remembers the preference for the session.

**memory-guidance.md** — Decides where durable content goes, and what each destination costs. It orders the eight destinations from cheapest to most expensive — from nowhere, through a path-scoped rule, a skill, auto-memory and personal and shared context, up to canonical context and an unconditional rule — and has the always-loaded cost stated before anything is written to one of the two that tax every session. It carries the test for what qualifies as canonical, and what belongs in auto-memory. While work is in flight, its decisions and progress belong to the task's chat drawer, not to auto-memory.

**work-item-tracking.md** — Defines the workspace's stance on issue tracking: when a tracker is configured in `workspace.json`, all work items live in the tracker (not in a local mirror), and skills read and write through a pluggable adapter at `.claude/scripts/trackers/{type}.mjs`. The template ships `github-issues` and `gitlab-issues` adapters; others can be added by dropping in a new module. The rule also describes when to create issues, how a task links to them through the `workItem:` on its chat record, and what state belongs in the tracker rather than on that record.

**workspace-structure.md** — Documents the directory layout, the three levels of `workspace-context/`, the file-naming conventions, and the structural rules (the root stays on its default branch, and only `local-only-*` files and the scratchpad are writable from it). It also settles where specs and plans go: in the task's chat drawer, overriding any default path an external skill might use.

**goal-driven-work.md** — Decides when Claude Code's built-in `/goal` command is the right shape for work: when it is multi-phase, has an end state you can verify, and will span more than a turn or two. The rule is the convention layer that keeps phase state durable across turns and resumes. Everything after that decision is the `/goal-driven-work` skill.

Two more rules ship active but load only on matching paths. They are described under [Path-Scoped Rules](#path-scoped-rules).

## Optional Rules

Nine rules ship in a deactivated state. These are available for teams that want them but not enforced by default:

**superpowers-workflow.md.skip** — Enforces a research-before-implementation workflow. Requires reviewing existing codebase patterns, searching documentation, and researching best practices before writing code. Designed for teams using the Superpowers plugin.

**scope-guard.md.skip** — Pushes back on scope creep during implementation. Flags when work expands beyond what was specified.

**documentation.md.skip** — Keeps documentation in step with code. A change that fixes a bug, corrects an API, or replaces a deprecated pattern must correct any documentation of the old behavior in the same session.

**token-economics.md.skip** — Token-aware behavior: cost-conscious model selection, context efficiency, command discipline, and waste detection.

**agent-rules.md.skip** — Conventions for subagent dispatch and coordination.

**cloud-infrastructure.md.skip** — Cloud-specific conventions for infrastructure work. All changes to cloud resources go through code and CI/CD — never the console, and never a CLI command against live resources.

**local-dev-environment.md.skip** — Keeps a `local-only-dev-environment.md` file at `workspace-context/shared/locked/` that captures machine-specific context (services, ports, credentials, CLI commands, env vars, paths, infrastructure). The file is gitignored, so it is never shared.

**product-integrity.md.skip** — Guards against personal biases being baked into product decisions. When a proposed feature directly mirrors a personal struggle, or when "I need this" is the primary justification, the rule prompts Claude to flag it and suggest keeping the change local-only or user-scoped until external feedback confirms general value. Useful for tools built by their own users.

**config-review.md.skip** — A reminder to review the workspace's own `.claude` components — rules, skills, agents and hooks — after each major model release and at least every 180 days. Conventions written for an older model generation can silently mis-steer a newer one, while the file still runs without error.

## The .skip Pattern

The workspace uses a three-state file convention for activation control:

| Extension | State | Meaning |
|-----------|-------|---------|
| `.md` | Active | Loaded on every turn (or only on `paths:` matches), shared with the team |
| `.md.skip` | Available | Present in the workspace but not loaded. Drop `.skip` to activate |
| `local-only-*.md` | Personal | Active on your machine, gitignored, not shared |

To activate an optional rule, rename it: `scope-guard.md.skip` becomes `scope-guard.md`. To deactivate an active rule for your local environment without affecting the team, rename it to add `.skip`. To add a personal rule that only you use, create a `local-only-` prefixed file.

This convention applies universally across the workspace — not just to rules but also to shared context files. It is the same mechanism everywhere: the file extension controls visibility, the `local-only-` prefix controls sharing.

The .skip pattern avoids the complexity of a configuration file that lists which rules are active. The file system is the configuration. If the file ends in `.md` and is in the rules directory, it is active. No registry, no toggle, no indirection.

## Path-Scoped Rules

A rule taxes context on every turn — unless it declares `paths:` frontmatter. A rule with a `paths:` array of globs loads only when Claude reads or edits a file matching one of them, so an instruction about calling a forge costs nothing while you are writing documentation, and vice versa.

One shipped rule is scoped this way:

- **forge-operations.md** — `**/.claude/skills/**` and `**/.claude/scripts/**`. The forge-adapter discipline only matters when writing the skills and scripts that call it.

Use `paths:` for your own rules whenever the instruction applies to specific files or directories rather than to every session — a rule about migration scripts does not need to be in context while editing documentation. `context-footprint.mjs` lists scoped rules separately from the always-loaded total, and `/maintenance` warns when that total exceeds `workspace.alwaysLoadedBudgetBytes`. Scoping composes with the .skip pattern: `paths:` decides *when* an active rule loads, `.skip` decides *whether* it loads at all.

## Loading Order and Priority

Rules participate in a priority chain:

1. **User instructions** (CLAUDE.md, direct requests) — highest priority
2. **Rules** — override default Claude behavior
3. **Default Claude behavior** — lowest priority

If CLAUDE.md says one thing and a rule says another, CLAUDE.md wins. This ensures that project-specific needs always take precedence over generic conventions.

Skills interact with rules differently. A skill can explicitly override a rule for the duration of its workflow. For example, the handoff skill auto-commits context captures, which overrides the git-conventions rule's normal commit process. The skill documents this override in its own instructions — it does not silently ignore the rule.

The general principle: rules set the constraints, skills define the workflows, and workflows can declare exceptions to constraints when the workflow requires it.

## Writing Custom Rules

To add a rule, create a markdown file in `.claude/rules/`:

```markdown
# My Custom Rule

## What This Means

- Specific behavioral instruction
- Another specific instruction

## Why

Explanation of why this rule exists, so Claude can apply judgment
in edge cases rather than following the letter blindly.
```

Structure your rule with clear, specific instructions followed by reasoning. The "Why" section is important — it gives Claude context to handle situations the rule does not explicitly cover. A rule that says "never use console.log" without explaining why will be followed literally. A rule that says "avoid console.log in production code because it creates noise in server logs" lets Claude make sensible exceptions during debugging.

Ship new rules as `.md.skip` if they are optional for the team. Ship them as `.md` if they should be active for everyone. Use `local-only-` for rules that are personal experiments. If a rule only matters when certain files are touched, give it `paths:` frontmatter so it costs nothing the rest of the time.

```
.claude/rules/
├── coherent-revisions.md          # Active — loaded every turn
├── git-conventions.md             # Active — loaded every turn
├── forge-operations.md             # Active, path-scoped — loads when a skill or script is touched
├── …                              # the rest of the active rules
├── scope-guard.md.skip            # Optional — available
├── config-review.md.skip          # Optional — available
├── …                              # the rest of the optional rules
└── local-only-my-experiment.md    # Personal — active on your machine only
```

---

## Key Takeaways

- Rules are always-loaded behavioral constraints. Every `.md` file in `.claude/rules/` is read on every turn — except the rule with `paths:` frontmatter (forge-operations), which loads only when a matching file is touched.
- The template ships seventeen rules: eight active, seven unconditional and one path-scoped, and nine optional `.skip` rules, which you activate by renaming.
- The .skip pattern is a universal three-state convention: `.md` (active), `.md.skip` (available), `local-only-` (personal).
- User instructions in CLAUDE.md take priority over rules. Skills can declare exceptions to rules.
