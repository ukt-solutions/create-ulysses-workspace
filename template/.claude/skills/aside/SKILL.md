---
name: aside
description: Capture a drive-by idea without interrupting your current work. Dispatches a background researcher by default, or use --quick for a simple note. Usage: /aside [--quick] <your thought>
---

# Aside

Capture a drive-by idea without interrupting the current conversation. By default, dispatches a background subagent to research and expand the idea. Use `--quick` for a simple note with no research.

## Parameters

- `/aside <thought>` — researched mode (default). Background subagent explores the idea.
- `/aside --quick <thought>` — note only. No subagent, no research. Just park the thought.

Everything after `/aside` (or `/aside --quick`) is the user's thought. No name parameter — the slug is generated from the content.

## Quick Mode (`--quick`)

No subagent. Execute these steps directly:

1. Parse the user's thought from the arguments (everything after `--quick`).
2. Generate a kebab-case slug from the content (3-5 words that capture the core idea).
3. Compose the body using the Quick Mode template below (verbatim user thought + a Further Investigation section with 2-3 inferred threads).
4. Use the centralized helper to compute the path, apply the `braindump_` prefix, write the frontmatter (with `variant: aside`), and stay gitignored:

```bash
echo "$BODY" | node .claude/scripts/capture-context.mjs \
  --type braindump \
  --topic {kebab-slug} \
  --scope team-member \
  --user {workspace.user} \
  --variant aside \
  --local-only
```

5. Report the printed path to the user: "Noted: `{path}`."

The helper handles collisions automatically by appending `-2`, `-3`, etc.

### Quick Mode Body Template

```markdown
## User's Original Thought
{Verbatim text from the user — copy exactly as provided}

## Further Investigation
{2-3 bullet points: threads worth pulling on, questions to explore,
related areas to check. Quick inference, not deep research.}
```

## Research Mode (default)

Dispatch the `aside-researcher` agent in the background. The full mode uses `--type research` so the file is named `local-only-research_{slug}.md`, distinguishing it from quick asides.

1. Parse the user's thought from the arguments (everything after `/aside`).
2. Generate a kebab-case slug from the content.
3. Compute the target path with `--print-only` so you can hand it to the subagent:
   ```bash
   node .claude/scripts/capture-context.mjs \
     --type research \
     --topic {kebab-slug} \
     --scope team-member \
     --user {workspace.user} \
     --variant aside \
     --local-only \
     --print-only
   ```
4. Dispatch the `aside-researcher` agent using the Agent tool:
   - `subagent_type`: use the `aside-researcher` agent definition
   - `run_in_background: true`
   - Prompt must include:
     - The user's verbatim thought
     - The target file path (from step 3)
     - The workspace root path
     - The Research Mode body template (below)
   - Tell the agent to write the body via `capture-context.mjs --update` so the same path is reused, and to pipe the rendered body on stdin.
5. Confirm dispatch to the user: "Researching in the background. I'll let you know when it's done."
6. When the agent completes, report: file path and a one-line summary of what was found.

### Research Mode Body Template

Include this template in the agent's prompt so it writes the correct format:

```markdown
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

- **Quick mode:** `workspace-context/team-member/{user}/local-only-braindump_{slug}.md`
- **Research mode:** `workspace-context/team-member/{user}/local-only-research_{slug}.md`
- **Slug:** Kebab-case, 3-5 words. E.g., `refresh-token-caching`, `deploy-pipeline-idea`.
- **Collision handling:** Helper auto-appends `-2`, `-3`, …
- **Always `local-only-`** — gitignored, never auto-committed.

## Session Behavior

Asides are session-agnostic. Regardless of whether a work session is active:
- Files always go to `workspace-context/team-member/{user}/`
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
