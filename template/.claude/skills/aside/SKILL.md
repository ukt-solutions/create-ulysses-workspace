---
name: aside
description: Capture a drive-by idea without interrupting your current work. Dispatches a background researcher by default, or use --quick for a simple note. Usage: /aside [--quick] <your thought>
---

# Aside

Capture a drive-by idea without interrupting the current conversation. By default, dispatches a background subagent to research and expand the idea. Use `--quick` for a simple note with no research.

## Parameters

- `/aside <thought>` — researched mode (default). Background subagent explores the idea.
- `/aside --quick <thought>` — note only. No subagent, no research. Just park the thought.

Everything after `/aside` (or `/aside --quick`) is the user's thought. No name parameter — the filename is generated from the content.

## Quick Mode (`--quick`)

No subagent. Execute these steps directly:

1. Parse the user's thought from the arguments (everything after `--quick`)
2. Generate a kebab-case slug from the content (3-5 words that capture the core idea)
3. Check if `shared-context/{user}/local-only-{slug}.md` exists. If so, append `-2`, `-3`, etc.
4. Infer 2-3 threads worth exploring later for the Further Investigation section
5. Write the file using the Quick Mode template below
6. Report the file path to the user: "Noted: `shared-context/{user}/local-only-{slug}.md`"

### Quick Mode Template

```yaml
---
state: ephemeral
lifecycle: active
type: braindump
variant: aside
author: {user}
updated: {YYYY-MM-DD}
---

## User's Original Thought
{Verbatim text from the user — copy exactly as provided}

## Further Investigation
{2-3 bullet points: threads worth pulling on, questions to explore,
related areas to check. Quick inference, not deep research.}
```

## Research Mode (default)

Dispatch the `aside-researcher` agent in the background:

1. Parse the user's thought from the arguments (everything after `/aside`)
2. Generate a kebab-case slug from the content (3-5 words that capture the core idea)
3. Check if `shared-context/{user}/local-only-{slug}.md` exists. If so, append `-2`, `-3`, etc.
4. Determine the target file path: `shared-context/{user}/local-only-{slug}.md`
5. Dispatch the `aside-researcher` agent using the Agent tool:
   - `subagent_type`: use the `aside-researcher` agent definition
   - `run_in_background: true`
   - Prompt must include:
     - The user's verbatim thought
     - The target file path
     - The workspace root path
     - The Research Mode template (below)
6. Confirm dispatch to the user: "Researching in the background. I'll let you know when it's done."
7. When the agent completes, report: file path and a one-line summary of what was found

### Research Mode Template

Include this template in the agent's prompt so it writes the correct format:

```yaml
---
state: ephemeral
lifecycle: active
type: braindump
variant: aside
author: {user}
updated: {YYYY-MM-DD}
---

## User's Original Thought
{Verbatim text from the user — copy exactly as provided, never paraphrase}

## Agent Research
{Findings from the workspace, project repos, and web.
References specific file paths and prior art.
Structured as prose or sub-headings as the content demands.}

## Synthesis
{How the user's thought connects to what was found.
Proposed next steps, design considerations.
Clearly framed as agent analysis, not user intent.}

## Further Investigation
{Threads worth pulling on. What the agent couldn't answer.
Topics that would benefit from deeper exploration or user input.}
```

## File Naming

- **Location:** `shared-context/{user}/local-only-{slug}.md`
- **Slug:** Generated from the thought content. Kebab-case, 3-5 words. E.g., `refresh-token-caching`, `deploy-pipeline-idea`
- **Collision handling:** If the file exists, append `-2`, `-3`, etc.
- **Always `local-only-`** — gitignored, never auto-committed

## Session Behavior

Asides are session-agnostic. Regardless of whether a work session is active:
- Files always go to `shared-context/{user}/`
- No interaction with the session tracker
- No interaction with `/complete-work` synthesis

## Lifecycle

Asides stay as `local-only-*` files until deliberately promoted:
- `/promote` discovers them during its `local-only-*` scan
- `/maintenance` can flag stale asides
- `variant: aside` frontmatter distinguishes them from other local-only files

## Notes

- The subagent receives locked context automatically via the SubagentStart hook
- The subagent does NOT receive conversation history — the user provides context inline as part of their thought
- Asides never modify existing files
- One aside = one file, always
