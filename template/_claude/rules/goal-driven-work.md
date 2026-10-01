# Goal-Driven Work

How to use Claude Code's built-in `/goal` command in a Ulysses workspace for multi-phase, agent-team-driven work. `/goal` is the autonomy loop; this rule is the convention layer that gives the main agent durable phase state and a consistent dispatch pattern across turns and resumes.

## When to reach for `/goal`

Use `/goal` when the work meets all three:

1. **Multi-phase.** It naturally decomposes into discrete phases (research, design, implementation, validation, etc.) and the phases produce intermediate artifacts before the work is done.
2. **Verifiable end state.** "Done" can be demonstrated from the conversation transcript — a PR opened, a set of artifacts written, a test suite passing — rather than judged subjectively.
3. **Spans more than one or two turns of natural conversation.** Single-skill invocations (one brainstorm, one plan, one fix) don't need `/goal`; the existing skills carry them.

If any of the three fails, prefer plain session work or a single skill invocation. `/goal` is overhead. Pay it only when the work is long enough to earn it.

## The convention lives in a skill

Everything past this decision — the `goal-{topic}.md` frontmatter schema, the three phase
types, agent-team dispatch, gate conventions, the integration-branch model with per-phase
sub-PRs, model tiering, and the worked example — is in the `goal-driven-work` skill.

Invoke it before drafting a goal artifact or running a goal phase. It is a skill rather than
a rule because it is a procedure needed by the small number of sessions that run `/goal`,
not a constraint every session must carry. Loading it on demand keeps roughly 27 KB out of
every session's always-loaded context.
