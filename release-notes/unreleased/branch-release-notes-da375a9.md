---
branch: feature/token-economics-sharpening
type: feature
author: myron
date: 2026-04-20
---

## Token-economics rule rewrite + bash-output advisory hook

Rewrites the opt-in `token-economics.md.skip` rule from vague guidance into a concrete operational checklist, and ships a new always-on PreToolUse hook that nudges the model away from the most common sources of bash output bloat.

### Rule rewrite

`template/.claude/rules/token-economics.md.skip` (still opt-in via `.skip`) gets four substantive changes:

- **New "Command Discipline" section** — the single biggest source of session bloat is unbounded bash output. The rule now spells out concrete practice: pipe to `head`/`tail`/`grep` first, scope test runners to a path, write large inspections to a tmp file and grep into it, use `run_in_background` for long-running processes, and don't claim a task is done before running its tests (the last point lifted from `claude-token-efficient`'s convention).
- **New "Ghost-Token Detection" section** replaces the previous vague "waste detection" bullets. Spells out the five structural sources of context spend that don't show up in any single tool result: unused skills, oversized locked context, unused MCP servers, resolved discussions still in scope, subagent context bloat. Adopts the "ghost tokens" mental model from the `alexgreensh/token-optimizer` project.
- **Locked-context threshold corrected** — drops the stale "10KB target" reference in favor of the context-window-percentage guidance shipped in v0.13.0-beta.2's `/maintenance` skill (5% yellow, 15% red). Both surfaces now agree.
- **Compaction Awareness** — sharpens to call out the `PreCompact` hook prompt as a real checkpoint rather than a dismissable nag.

The rule remains `.skip` — opt-in. Activation is a separate decision; the always-on work sits in the new hook.

### `bash-output-advisory.mjs` hook (PreToolUse)

A new PreToolUse hook gated on `tool_name === "Bash"`. Detects four narrow patterns and emits a one-line `additionalContext` nudge:

- Bare test-runner invocations (`npm test`, `yarn test`, `pnpm test`, `bun test`, `cargo test`) with no path, filename, or test-name filter.
- `grep -r` / `grep --recursive` without `--include` or `--exclude`.
- `find` rooted at `/`, `~`, or `$HOME` without a `-name`/`-path`/`-iname`/`-ipath`/`-regex` constraint.
- `cat` on `.log` / `.jsonl` / `.ndjson` files.

Does **not** modify the command. The model can still run the unbounded form if it has reason to. Patterns are deliberately narrow — false positives train the model to ignore the hook, and the verified Claude Code hook contract is that PostToolUse cannot modify Bash output (only `block` or `additionalContext`-append), so a stricter approach (e.g., truncating the result post-hoc) isn't feasible. PreToolUse pipe-rewriting was considered and rejected as too fragile (`npm test | grep FAIL` would silently lose fail signals when wrapped in `| head`).

The hook short-circuits when the command is already piped to a bounding sink (`| head`, `| tail`, `| grep`, `| rg`, `| wc`, `| less`, `| more`) or when output is redirected to a file (`>`, `>>`, `| tee FILE`).

42 unit tests in `_bash-output-advisory.test.mjs` cover the positive and negative paths. The `_` prefix matches the existing `_utils.test.mjs` convention so the audit-tarball hooks-count predicate excludes the test file from the hook count.

### Wiring

- `template/.claude/settings.json` PreToolUse now lists three hooks: `workspace-update-check`, `repo-write-detection`, and the new `bash-output-advisory`. Same 5000ms timeout as siblings.
- README "What you get" bumped from 8 → 9 hooks. `npm run audit:tarball` confirms the count matches the filesystem (89 files, 108.2 kB tarball — up from 86 / 104.0 kB).

### Why the original plan changed mid-session

The session opened with a plan for a PostToolUse truncation hook (keep first 250 + last 250 lines, replace the middle with a notice). Verifying the Claude Code hook contract revealed that PostToolUse **cannot** modify Bash output — only MCP tool output is mutable via `updatedMCPToolOutput`, and Bash isn't an MCP tool. The advisory hook is the strongest thing the runtime actually permits, paired with the rule for the discipline the runtime can't enforce.

### Out of scope (potential follow-ups)

- Promoting `token-economics.md` from `.skip` to mandatory — requires a separate decision; the rule's recommendations interact with model selection (Opus vs Sonnet) which not every workspace wants enforced.
- Impact-ranked output for `/handoff` (the third pattern from the same research that prompted this work — Token Savior's persistent-memory idea).
- Making the audit-tarball hooks-count predicate exclude `*.test.mjs` explicitly rather than relying on the `_` prefix happy-accident — already a known follow-up from v0.13.0-beta.0.
- Expanding the hook's pattern list as real workflows surface untracked offenders. Start narrow; widen on evidence.
