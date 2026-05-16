# Goal-Driven Work

How to use Claude Code's built-in `/goal` command in a Ulysses workspace for multi-phase, agent-team-driven work. `/goal` is the autonomy loop; this rule is the convention layer that gives the main agent durable phase state and a consistent dispatch pattern across turns and resumes.

## When to reach for `/goal`

Use `/goal` when the work meets all three:

1. **Multi-phase.** It naturally decomposes into discrete phases (research, design, implementation, validation, etc.) and the phases produce intermediate artifacts before the work is done.
2. **Verifiable end state.** "Done" can be demonstrated from the conversation transcript — a PR opened, a set of artifacts written, a test suite passing — rather than judged subjectively.
3. **Spans more than one or two turns of natural conversation.** Single-skill invocations (one brainstorm, one plan, one fix) don't need `/goal`; the existing skills carry them.

If any of the three fails, prefer plain session work or a single skill invocation. `/goal` is overhead. Pay it only when the work is long enough to earn it.

## File layout

- One `goal-{topic}.md` artifact at the top of the active worktree, alongside `session.md`. One goal per worktree.
- Phase output artifacts live as siblings. `research-*.md` and `crossref-*.md` are goal-native (produced by `parallel-research` and `crossref` phase types). `design-*.md` and `plan-*.md` are pre-existing session-artifact patterns that `type: skill` phases reuse when the wrapped skill is `superpowers:brainstorming` or `superpowers:writing-plans`; they are not goal-specific.
- The artifact is tracked on the session branch and lives there until `/complete-work` runs. It is removed from the branch before the final PR alongside other session artifacts.

## Frontmatter schema

```yaml
---
type: goal
topic: <kebab-case-topic>
status: active                  # pending | active | complete | cancelled
                                # pending: artifact written but /goal not yet invoked
                                # active: /goal loop is running
                                # complete: all phases complete and condition met
                                # cancelled: goal abandoned without completion
current_phase: <phase-name>     # the phase currently in progress or next up
completion_condition: >         # mirrored from the `/goal` text so it survives `/goal clear` and is auditable
  <multi-line condition string>
turn_budget: <int>              # backstop; the condition itself should reference it
phases:
  - name: <phase-name>
    type: parallel-research | crossref | skill
    status: pending             # pending | in_progress | complete | failed
    artifact: <path or null>    # output artifact path, relative to worktree top; null for phases that commit to repo
    gate: review | auto         # default: review

    # for type: parallel-research
    team:
      agents:
        - subagent_type: <type>
          brief: |
            <multi-line brief>
        - subagent_type: <type>
          brief: |
            <multi-line brief>
      synthesizer:
        subagent_type: <type>
        brief: |
          <multi-line brief: reads sibling agent outputs, writes the phase artifact>

    # for type: crossref
    inputs:
      independent: <path to the just-produced independent artifact>
      against: <path or list of paths to compare against>
    brief: |
      <multi-line brief for the crossref agent>

    # for type: skill
    skill: <plugin:skill-name>   # e.g. superpowers:brainstorming
---
```

Body of the file is human-readable: the goal statement, success criteria, and per-phase intent in prose. The frontmatter is the source of truth for machine state; the body explains it to a reader.

## Phase types

Three types in v1. Prefer wrapping existing skills (`type: skill`) when a skill fits. Only invent a phase type when no skill covers the work.

- **`parallel-research`**: dispatch N researcher-style agents in parallel with independent briefs. Optionally run a synthesizer agent over their outputs to write one consolidated artifact. Use for tool surveys, option-space exploration, comparative research where work can be partitioned.
- **`crossref`**: given source A (the independent output the team just produced) and source B (existing material to validate against), dispatch an agent to produce a gap-and-overlap matrix plus a ranked list of validations and concerns. Use to compare independent work against prior research, canonical workspace context, or third-party material.
- **`skill`**: invoke an existing skill by name. The phase's `artifact:` path is the expected output location (or `null` for phases that commit to repo, like `executing-plans`). Use this for `brainstorming`, `writing-plans`, `executing-plans`, `test-driven-development`, or any other skill that fits the phase's intent.

If a new phase type appears to be needed, justify why no existing skill fits before adding it. New phase types are a maintenance cost. Prefer keeping `parallel-research` and `crossref` inline until cross-goal reuse pressure makes the extraction earn its keep.

## Agent-team dispatch pattern (v1: stateless)

A "team" is just a list of `Agent`-tool dispatch configs (`subagent_type` + `brief`). Spawned fresh each phase. No persistent identity, no memory across phases except what's written into artifacts.

The main agent's responsibility per phase:

1. Mark the phase `in_progress` in `goal-{topic}.md` frontmatter.
2. Dispatch the team via the `Agent` tool, in parallel where independent. The brief for each agent is exactly the `brief:` field from the phase config, prefixed with any context the brief itself doesn't already carry (typically a pointer to relevant sibling artifacts).
3. Collect agent outputs.
4. If a `synthesizer` is declared, dispatch it with the sibling outputs and have it write the `artifact:` file.
5. If no synthesizer, the main agent writes the `artifact:` file directly from the collected outputs.
6. Mark the phase `complete`, update `current_phase` to the next pending phase.
7. End the turn with a short status note (for the `/goal` evaluator) and, if `gate: review`, an explicit question to the user.

The artifact format supports adding a `persistent: true` flag on a phase team later if a future goal needs team continuity across phases. Don't add the field until something asks for it.

## Gate convention

`gate: review` is the default for every phase. At the gate, the main agent ends its turn by asking the user to approve, reject with feedback, or pause.

- **approve** → phase stays `complete`, advance to next phase next turn.
- **reject with feedback** → flip phase back to `pending` and re-run it with the feedback prepended to the team brief.
- **pause** → state is durable in `goal-{topic}.md`; resume with `claude --resume`.

The evaluator's "no, awaiting review" response after a gated phase does not bypass the wait for user input. It just keeps the session running until the user replies.

`gate: auto` is allowed in the format but discouraged in v1. Earn it after the workflow has been exercised at least once on the work in question.

## Integration branch and per-phase sub-PRs

While a `/goal`-driven session is running, the session branch (`feature/{session-name}`) acts as the goal's integration branch. Main is untouched until `/complete-work` opens the final session→main PR for human review. This is the key autonomy boundary: phase agents can merge their own work, repeatedly, throughout the goal — but only into the integration branch, never into main.

Two merge strategies, picked per phase:

- **Direct commit (default for artifact-only phases).** Phases of type `parallel-research` and `crossref`, and skill phases that wrap artifact-producing skills (`brainstorming`, `writing-plans`), commit their outputs directly to the session branch. These artifacts are stripped before the final PR anyway, so sub-PR ceremony adds nothing.
- **Sub-branch with self-merged PR (default for code phases).** Skill phases that wrap code-producing skills (`executing-plans`, `test-driven-development`, `subagent-driven-development`) work on a per-phase sub-branch and open a PR back to the session branch. After the phase's gate is satisfied, the main agent self-merges the sub-PR. Each sub-PR is a discrete reviewable unit — failures can be retried by rebuilding just the one sub-branch.

Sub-branch naming follows the existing `git-conventions.md` rule (kebab-case after prefix, no nesting): `feature/{session-name}-{phase-name}`. Examples for a session named `ulysses-goals`:

- `feature/ulysses-goals` — session/integration branch
- `feature/ulysses-goals-strategy-research` — phase sub-branch (if a research phase were promoted to sub-branch strategy)
- `feature/ulysses-goals-implement` — phase sub-branch for the implement phase

A phase declares its merge strategy in frontmatter via an optional `integration:` block:

```yaml
phases:
  - name: implement
    type: skill
    skill: superpowers:executing-plans
    integration:
      strategy: sub-branch        # direct | sub-branch
      branch: feature/{session-name}-implement   # explicit, or derived if omitted
      self_merge: true            # main agent merges the sub-PR after gate is satisfied; default true
```

If `integration:` is omitted, defaults are applied by phase type per the list above.

Multi-repo sessions: each project repo has its own session branch (same name across repos per existing convention). Phase sub-branches are created per-repo where the phase commits, with matching names. The sub-PR target in each repo is that repo's session branch.

`/complete-work` verifies before the final PR that every phase sub-branch has been merged into the session branch. If any are outstanding, it fails loudly with a list of unmerged sub-branches. The user resolves them (merge or close) before re-running.

## Model tiering

`/goal`-driven work uses a three-tier model assignment, biased toward the right tool for each shape of work:

- **Opus** for the main orchestration thread. It reads the goal artifact, dispatches phase teams, holds the long-running session context, and makes the per-phase advance/retry decisions. Reasoning-heavy and context-heavy work.
- **Sonnet** for phase team agents (researchers, crossref agents, skill subagents) and for synthesizers. Heavy lifting that runs in parallel and writes substantial artifacts. The default model for any agent in a `team:` block.
- **Haiku** for quick checks: file-existence verification, frontmatter validation, status sweeps, tiny lookups. Use when the work is bounded and obvious, and speed matters more than reasoning depth.

Phase frontmatter sets the model per agent via the `model:` field, which maps to the `Agent` tool's `model` parameter:

```yaml
team:
  agents:
    - subagent_type: researcher
      model: sonnet           # default for parallel-research; rarely overridden
      brief: |
        ...
  synthesizer:
    subagent_type: researcher
    model: sonnet
    brief: |
      ...
```

For artifact-only or tagging work where Haiku is enough, declare it explicitly:

```yaml
- subagent_type: researcher
  model: haiku
  brief: |
    Scan {paths} for files matching {pattern} and return a tagged list.
```

The main agent's model is determined by the harness (the user's `claude` invocation), not the goal artifact. Goal artifacts assume the main agent runs on Opus.

## Writing a good completion condition

The `/goal` evaluator runs after every turn against the conversation transcript. It does not call tools, so it can only judge what the main turn has surfaced. A good condition is:

- **Specific.** Names the artifacts that must exist (file paths, commit references, PR URLs) rather than vague outcomes.
- **Demonstrable from transcript.** The main agent's own output must be able to evidence completion. "The PR URL was reported in the transcript and `git status` showed clean" rather than "the work feels done."
- **Bounded.** Includes a turn budget as a backstop (e.g., "or stop after 60 turns") so the loop can't run away if something goes wrong.
- **Within the 4000-char limit.** Up to four kilobytes of condition text are accepted.

A reasonable template:

```
All phases in goal-<topic>.md show status: complete. Phase artifacts exist at: <list paths>. The /complete-work skill has produced release notes and opened the final PR; the PR URL appeared in the transcript. Or stop after <N> turns.
```

Fill in `<topic>`, paths, and `<N>` per goal. Anchor on artifacts and committed state, not on feelings.

## Lifecycle integration

- `/goal` runs inside an active work session. It does NOT replace `/start-work`. The session is created the normal way, the goal artifact is drafted at the worktree top, then `/goal "<condition>"` kicks off the loop.
- The goal artifact lives on the session branch and travels with `git push`. It survives across machines and `--resume`.
- `session.md`'s `## Tasks` should mirror the phase list at coarse grain (one task per phase) so `TodoWrite` shows high-level progress. The main agent updates `## Tasks` at phase transitions via the helper specified by the `task-list-mirroring` rule, in addition to updating `goal-{topic}.md`.
- `/pause-work` works without special handling. The goal-evaluator state resets on resume per the Claude Code docs; phase state is durable in the artifact.
- `/complete-work` reads `goal-*.md`, `research-*.md`, and `crossref-*.md` for release-note synthesis and strips them from the branch before the final PR, alongside the existing `design-*.md` and `plan-*.md` handling. When a goal artifact is present, it also runs a pre-flight check that every declared sub-branch (from phases with `integration.strategy: sub-branch`) has been merged into the session branch. Unmerged sub-branches abort completion with a clear list to resolve.

If a research or crossref artifact deserves to outlive the branch, the user runs `/promote` on it before `/complete-work`. `/promote` accepts arbitrary paths and routes them into `workspace-context/`.

## Tracker integration

Goals do not replace work items. A goal is execution shape; a work item is the unit the team tracks. See `work-item-tracking.md` for how `workItem:` in session frontmatter links a session to its tracker issue. A goal lives inside a session and therefore inherits the session's `workItem:`.

When the goal artifact is itself the deliverable for a future session to execute (i.e., this session's job was to *write* the goal, and another session will *run* it), the strip rule needs an escape hatch. The pattern: preserve the artifact in the tracker issue body (as a fenced code block) before `/complete-work` runs. The future session picks up the issue via `/start-work`, copies the artifact text into its worktree top, and runs `/goal`. The strip rule stays clean and consistent; the deliverable is preserved through the tracker.

## Out of scope

- Nested or sub-goals. v1 is flat.
- DAG between phases. Sequential at the phase level; parallelism only inside a phase via the team agents.
- Persistent named teams (`TeamCreate`). v1 is stateless dispatch.
- Frontmatter linter for `goal-*.md`. Manual review is fine for v1; revisit if workspaces using the template hit consistent shape errors.
- `/start-work` seeding of a `goal-{slug}.md` skeleton. Manual drafting is the v1 path. The drafting itself is high-leverage thinking; a template skeleton would risk skipping that.

## Appendix: worked example

A complete `goal-evaluate-rate-limiting.md` illustrating all three phase types. The topic is intentionally generic — the example is reference material, not prescriptive.

```yaml
---
type: goal
topic: evaluate-rate-limiting
status: pending
current_phase: strategy-research
completion_condition: >
  All 5 phases in goal-evaluate-rate-limiting.md show status: complete.
  Phase artifacts exist at: research-rate-limiting-strategies.md,
  crossref-existing-infrastructure.md, design-rate-limiting.md,
  plan-rate-limiting.md, and the implementation commits land on the session
  branch (visible in git log). The /complete-work skill has produced release
  notes and opened the final PR; the PR URL appeared in the transcript.
  Or stop after 60 turns.
turn_budget: 60
phases:
  - name: strategy-research
    type: parallel-research
    status: pending
    artifact: research-rate-limiting-strategies.md
    gate: review
    integration:
      strategy: direct                   # artifact-only phase; commits straight to session branch
    team:
      agents:
        - subagent_type: researcher
          model: sonnet
          brief: |
            Research the token-bucket rate-limiting algorithm. Cover the
            mechanics, parameter trade-offs (capacity, refill rate), edge
            cases (burst behavior, clock skew), reference implementations in
            popular libraries, and known production failure modes.

            Output: a markdown report under 1,200 words. Return the content
            in your response.
        - subagent_type: researcher
          model: sonnet
          brief: |
            Research the sliding-window rate-limiting algorithm. Cover both
            the sliding log and sliding counter variants, accuracy
            trade-offs, memory cost at scale, reference implementations, and
            known production failure modes.

            Output: a markdown report under 1,200 words. Return the content
            in your response.
        - subagent_type: researcher
          model: sonnet
          brief: |
            Research the leaky-bucket rate-limiting algorithm. Cover the
            queue-based and meter-based variants, smoothing behavior under
            burst, comparison to token bucket, reference implementations,
            and known production failure modes.

            Output: a markdown report under 1,200 words. Return the content
            in your response.
      synthesizer:
        subagent_type: researcher
        model: sonnet
        brief: |
          Synthesize the three algorithm reports into a single
          recommendation document at research-rate-limiting-strategies.md
          (top of the active worktree).

          Frontmatter: type: research, topic: rate-limiting-strategies,
          state: ephemeral, lifecycle: active, confidence: medium,
          updated: <today's date>.

          Document structure:
          - One-line recommendation up front
          - Comparison table across criteria (accuracy, memory cost, burst
            behavior, implementation complexity, operational debuggability)
          - Per-algorithm summary with strengths and weaknesses
          - Risks and unknowns
          - References

          Maximum 2,000 words.

  - name: crossref-existing-infrastructure
    type: crossref
    status: pending
    artifact: crossref-existing-infrastructure.md
    inputs:
      independent: research-rate-limiting-strategies.md
      against:
        - workspace-context/canonical.md
        - repos/api-gateway/
    gate: review
    integration:
      strategy: direct
    agent:
      subagent_type: researcher
      model: sonnet
    brief: |
      Compare the rate-limiting strategy recommendation against the
      existing infrastructure (the repos/api-gateway/ codebase and any
      relevant canonical workspace context).

      Produce a gap-and-overlap matrix: where does the recommended
      strategy align with current patterns, where does it diverge, and
      what migration friction is implied. Rank concerns by severity.

  - name: spec
    type: skill
    status: pending
    skill: superpowers:brainstorming
    artifact: design-rate-limiting.md
    gate: review
    integration:
      strategy: direct                   # spec lands as design-*.md at worktree top; stripped before final PR

  - name: plan
    type: skill
    status: pending
    skill: superpowers:writing-plans
    artifact: plan-rate-limiting.md
    gate: review
    integration:
      strategy: direct

  - name: implement
    type: skill
    status: pending
    skill: superpowers:executing-plans
    artifact: null
    gate: review
    integration:
      strategy: sub-branch               # code phase: sub-branch + self-merged PR
      branch: feature/{session-name}-implement
      self_merge: true
---

# Goal: Evaluate and ship a rate-limiting strategy

The api-gateway needs rate limiting before the next traffic step-up. This
goal runs the full arc from candidate-algorithm research through implementation
on the session branch.

## Per-phase intent

1. **strategy-research** runs three researchers in parallel, one per
   candidate algorithm, plus a synthesizer that writes the comparative
   recommendation.

2. **crossref-existing-infrastructure** validates the recommendation
   against the current api-gateway codebase and canonical workspace
   context, surfacing migration friction and divergences.

3. **spec** wraps `superpowers:brainstorming` to produce the design doc
   from the validated recommendation.

4. **plan** wraps `superpowers:writing-plans` to produce the
   implementation checklist.

5. **implement** wraps `superpowers:executing-plans` on a per-phase
   sub-branch (`feature/{session-name}-implement`). The main agent opens
   a PR from the sub-branch back into the session/integration branch and
   self-merges once the gate is satisfied. Sub-branch is deleted post-merge.

Each gate is `review`: the user approves, rejects with feedback, or
pauses at the end of every phase. No auto-advance in v1.

All phase agents and synthesizers run on Sonnet (the default for team work).
The main agent reading and orchestrating this goal runs on Opus. Haiku is
unused in this example; it would be appropriate for a phase whose sole job
is, e.g., scanning a tree and returning a tagged file list.
```
