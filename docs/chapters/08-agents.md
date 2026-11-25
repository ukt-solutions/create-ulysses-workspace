# Agents

Agents are specialized subagent definitions that skills dispatch for focused work. Each agent is a markdown file in `.claude/agents/` that describes a role — what the agent does, what tools it can use, and how it should behave. When a skill needs a researcher, a reviewer, or an implementer, it launches the appropriate agent as a subagent with its own context and toolset.

This chapter covers the built-in agents, how context injection works, and how to define your own.

---

## The Subagent Problem

When Claude Code launches a subagent, the subagent starts with zero conversation history. It does not know what you have been discussing, what decisions were made, or what the project is about. It receives only the prompt that dispatched it.

This is a fundamental constraint of the subagent model. Each subagent is an independent Claude instance — it cannot read the parent conversation. Without intervention, every subagent would need explicit context pasted into its dispatch prompt, and the dispatcher would need to remember what context to include.

The workspace solves this structurally. The SubagentStart hook gives every subagent the workspace's canonical truths: the files in `workspace-context/shared/locked/`, the same ones the main session reads on every turn. Team knowledge — project status, architectural decisions, coding standards — arrives without anyone remembering to provide it. The subagent knows what the project is and how it works from its first token.

Subagents do not load CLAUDE.md, so this is the only way that knowledge reaches them. The hook keeps the injection small. A locked file is inlined, with its frontmatter stripped, when it is at most `workspace.subagentInlineMaxBytes` (8 KB from the template). A longer one becomes a one-line pointer that the subagent can follow if its task touches it. [Chapter 7](07-hooks-and-scripts.md#subagent-start) has the detail.

## Agent Definitions

An agent definition is a markdown file with YAML frontmatter that specifies the agent's role:

```yaml
---
name: researcher
description: Deep codebase and documentation research.
model: sonnet
tools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - LSP
disallowedTools:
  - Edit
  - Write
  - Bash
effort: high
---
```

The frontmatter controls:

- **name** — how the agent is referenced when dispatched.
- **description** — what the agent does, and when to reach for it. This is the line the parent reads when choosing an agent.
- **model** — which Claude model to use: `sonnet`, `opus`, or `inherit` for the parent's model. The shipped agents use Sonnet for research and Opus for review.
- **tools** — which tools the agent can access. A researcher gets read-only tools. An implementation agent gets write tools. This is the primary safety mechanism.
- **disallowedTools** — explicitly blocked tools, for clarity and enforcement.
- **isolation** — `worktree` runs the agent in a git worktree of its own, so its changes cannot collide with the parent's working directory.
- **effort** — the thinking effort level (high, medium, low).

The markdown body below the frontmatter contains the agent's behavioral instructions — what it does, how it works, what it must not do, and how to format its output.

## Built-In Agents

The workspace ships with four agent definitions:

### researcher

A read-only research specialist. Searches the codebase and web for information, reports findings with exact file paths, flags contradictions between code and documentation. Cannot modify any files.

**Tools:** Read, Glob, Grep, WebSearch, WebFetch, LSP
**Model:** Sonnet
**Use case:** Understanding existing patterns, finding prior art, investigating how something works before making changes.

### implementer

A focused execution agent for well-defined tasks. Works in an isolated worktree and has full write access. Designed for implementing one task from a plan with a clear spec.

**Tools:** Full toolset including Edit, Write, Bash
**Model:** Inherited from the parent
**Use case:** Executing implementation plan tasks where the spec is clear and the work is bounded.

### reviewer

A code review agent. Reads code, runs tests, checks implementations against specs and conventions. Reports findings but does not make changes.

**Tools:** Read, Glob, Grep, Bash (for running tests), LSP
**Model:** Opus
**Use case:** Reviewing completed work before merging. Checking implementations against plans.

### aside-researcher

A background research agent for the `/aside` skill. Receives a user's drive-by idea, researches it against the codebase and web, and writes a single output file with the original thought preserved verbatim alongside findings.

**Tools:** Read, Glob, Grep, WebSearch, WebFetch, Write (single file only)
**Model:** Sonnet
**Use case:** Expanding on drive-by ideas without interrupting the current work session.

## How Skills Dispatch Agents

Skills reference agents by name in their instructions. When the `/aside` skill needs to research an idea in the background, it dispatches the `aside-researcher` agent with the user's thought and a target file path. The agent runs independently — the parent conversation continues while the agent works.

The dispatch includes:
- The agent definition (from `.claude/agents/{name}.md`)
- The specific prompt for this invocation (from the skill)
- Canonical context (automatically, via the SubagentStart hook)

The agent does its work and produces output (typically a file or a report). The parent conversation is notified when the agent completes.

## Writing Custom Agents

To create a custom agent, add a markdown file to `.claude/agents/`:

```markdown
---
name: my-agent
description: What this agent does in one line.
model: sonnet
tools:
  - Read
  - Glob
  - Grep
disallowedTools:
  - Edit
  - Write
  - Bash
effort: high
---

You are a [role description]. Your job is to [primary task].

## What you receive
- [Input description]
- Canonical context (auto-injected by SubagentStart hook)

## How to work
1. [Step-by-step instructions]

## Output format
[How to structure the results]
```

Key principles for agent design:

**Restrict tools to what the agent needs.** A research agent should not have write access. An implementation agent should not have web search. Tool restrictions are the primary safety boundary.

**Be explicit about what the agent must not do.** "Do not modify existing files" is clearer than hoping the tool restrictions are sufficient.

**Design for zero conversation context.** The agent will not know what you discussed. Everything it needs must be in its dispatch prompt or in the canonical context that gets injected automatically.

**Keep agents focused.** One agent, one role. A "researcher-and-implementer" agent defeats the purpose of the separation. If a task needs research then implementation, dispatch two agents sequentially.

---

## Key Takeaways

- Agents are subagent definitions in `.claude/agents/` — markdown files that describe specialized roles.
- Subagents start with zero conversation history. The SubagentStart hook solves this by injecting canonical context automatically.
- Four built-in agents: researcher (read-only), implementer (full access, isolated worktree), reviewer (read + test), aside-researcher (background idea expansion).
- Tool restrictions are the primary safety boundary — give each agent only what it needs.
- Custom agents follow the same pattern: frontmatter for configuration, body for behavioral instructions.
