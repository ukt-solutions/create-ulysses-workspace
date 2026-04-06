# Rules

Rules are behavioral constraints that Claude follows on every turn. They are markdown files in `.claude/rules/` that define how Claude should approach work — how to handle git, how to write revisions, how to push back on bad ideas, how to manage memory. Rules are loaded automatically alongside CLAUDE.md, making them part of the always-on context.

This chapter covers the mandatory and optional rules, the .skip activation pattern, and how to write your own.

---

## What Rules Do

A rule is a markdown file that gives Claude standing instructions. Unlike skills, which are invoked on demand for specific workflows, rules apply to every interaction. They shape Claude's default behavior — how it commits code, how it revises documents, how it decides what to remember.

Rules live in `.claude/rules/` and are tracked in git. Every `.md` file in this directory is loaded on every turn. This means the team shares the same behavioral constraints, and changes to rules are versioned and reviewable like any other code change.

## Mandatory Rules

Five rules ship as active by default. These encode the core conventions that make the workspace function correctly:

**coherent-revisions.md** — When revising any document or code, rewrite the affected section from start to finish so the result reads as a single coherent piece. Never patch or inject content between existing blocks. This applies to everything: docs, specs, code, context files, release notes, commit messages. The rule exists because injected revisions create fragmented output where the seams between old and new content are visible.

**git-conventions.md** — Branch naming (`feature/`, `bugfix/`, `chore/` prefixes, kebab-case), worktree naming (`{session}___wt-{type}`), conventional commit format (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`), and branch maintenance (rebase before PR, never auto-resolve conflicts). These conventions keep git history clean and worktree naming predictable.

**honest-pushback.md** — Claude must challenge assumptions, flag concerns, and push back when something seems wrong — even if the user is enthusiastic about it. If an approach has obvious downsides, say so. If scope is creeping, name it. If you do not know something, say so. This rule prevents sycophantic behavior that wastes time and lets bad decisions through unchallenged.

**workspace-structure.md** — Documents the directory layout, shared context levels, naming conventions, and structural rules (root stays on main, only local-only and scratchpad are writable from root). This is both documentation for Claude and a constraint — Claude uses it to verify that it is writing to the correct locations.

**memory-guidance.md** — Controls Claude's auto-memory system. Defines what to remember (architecture decisions, patterns that caused bugs, user corrections) and what not to remember (temporary state, file contents, anything already in shared context). During active work sessions, session-specific information goes in the inflight tracker, while cross-session insights go in auto-memory.

## Optional Rules

Six additional rules ship in a deactivated state. These are available for teams that want them but not enforced by default:

**superpowers-workflow.md.skip** — Enforces a research-before-implementation workflow. Requires reviewing existing codebase patterns, searching documentation, and researching best practices before writing code. Designed for teams using the Superpowers plugin.

**scope-guard.md.skip** — Pushes back on scope creep during implementation. Flags when work expands beyond what was specified.

**documentation.md.skip** — Enforces documentation standards for code changes.

**token-economics.md.skip** — Awareness of token costs. Encourages efficient context usage and appropriate subagent model selection.

**agent-rules.md.skip** — Conventions for subagent dispatch and coordination.

**cloud-infrastructure.md.skip** — Cloud-specific conventions for infrastructure work.

## The .skip Pattern

The workspace uses a three-state file convention for activation control:

| Extension | State | Meaning |
|-----------|-------|---------|
| `.md` | Active | Loaded on every turn, shared with the team |
| `.md.skip` | Available | Present in the workspace but not loaded. Drop `.skip` to activate |
| `local-only-*.md` | Personal | Active on your machine, gitignored, not shared |

To activate an optional rule, rename it: `scope-guard.md.skip` becomes `scope-guard.md`. To deactivate a mandatory rule for your local environment without affecting the team, rename it to add `.skip`. To add a personal rule that only you use, create a `local-only-` prefixed file.

This convention applies universally across the workspace — not just to rules but also to shared context files. It is the same mechanism everywhere: the file extension controls visibility, the `local-only-` prefix controls sharing.

The .skip pattern avoids the complexity of a configuration file that lists which rules are active. The file system is the configuration. If the file ends in `.md` and is in the rules directory, it is active. No registry, no toggle, no indirection.

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

Ship new rules as `.md.skip` if they are optional for the team. Ship them as `.md` if they should be active for everyone. Use `local-only-` for rules that are personal experiments.

```
.claude/rules/
├── coherent-revisions.md          # Mandatory — active
├── git-conventions.md             # Mandatory — active
├── honest-pushback.md             # Mandatory — active
├── workspace-structure.md         # Mandatory — active
├── memory-guidance.md             # Mandatory — active
├── scope-guard.md.skip            # Optional — available
├── token-economics.md.skip        # Optional — available
└── local-only-my-experiment.md    # Personal — active locally
```

---

## Key Takeaways

- Rules are always-loaded behavioral constraints. Every `.md` file in `.claude/rules/` is read on every turn.
- Five mandatory rules ship active: coherent-revisions, git-conventions, honest-pushback, workspace-structure, memory-guidance.
- Six optional rules ship as `.md.skip` — rename to activate.
- The .skip pattern is a universal three-state convention: `.md` (active), `.md.skip` (available), `local-only-` (personal).
- User instructions in CLAUDE.md take priority over rules. Skills can declare exceptions to rules.
