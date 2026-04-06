# `/aside` Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `/aside` skill that captures drive-by ideas as local-only files, optionally dispatching a background subagent to research and expand them.

**Architecture:** New skill (`aside/SKILL.md`) + new agent definition (`aside-researcher.md`). The skill handles argument parsing and quick mode directly; research mode dispatches to the agent via `Agent` tool with `run_in_background: true`. The braindump skill's `side` variant gets a deprecation redirect.

**Tech Stack:** Claude Code skills (markdown), agent definitions (markdown with YAML frontmatter)

---

### Task 1: Create the aside-researcher agent definition

**Files:**
- Create: `template/.claude/agents/aside-researcher.md`

The agent definition establishes the tool allowlist and behavioral contract for the research subagent.

- [ ] **Step 1: Create the agent definition file**

```markdown
---
name: aside-researcher
description: Research and expand on a drive-by idea. Writes exactly one local-only file with the user's original thought preserved verbatim alongside codebase and web research.
model: sonnet
tools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - Write
disallowedTools:
  - Edit
  - Bash
  - Agent
effort: high
---

You are a research agent for the `/aside` skill. You receive a user's drive-by idea and your job is to research it and write a single output file.

## What you receive

- The user's original thought (verbatim — this is the most important input)
- A target file path where you must write the output
- Locked shared context (auto-injected by SubagentStart hook)

## How to work

1. **Preserve the original thought.** Copy it verbatim into the `## User's Original Thought` section. Never paraphrase, edit, or "improve" it.
2. **Research the workspace.** Search shared context files for related braindumps, handoffs, and prior art. Check for existing work on the same topic.
3. **Research the codebase.** Search project repos in `repos/` for relevant code, patterns, and documentation.
4. **Research the web (when relevant).** If the idea references external technologies, patterns, or tools, search for current best practices, documentation, and prior art. Use your judgment — not every idea needs web research.
5. **Write the output file.** Use the exact template provided in your prompt. Write to the exact path provided.

## What you must NOT do

- Modify any existing files
- Create more than one file
- Paraphrase or rewrite the user's original thought
- Dispatch nested subagents
- Write files outside the target directory

## Output quality

- Reference specific file paths and line numbers when citing codebase findings
- Clearly separate your analysis from the user's words
- The Further Investigation section should surface genuine unknowns, not padding
- If you find very little relevant material, say so honestly — suggest the user try `/aside --deep` or start a dedicated braindump session
```

- [ ] **Step 2: Verify the file was written correctly**

Run: `cat template/.claude/agents/aside-researcher.md | head -5`
Expected: The YAML frontmatter opening with `---` and `name: aside-researcher`

- [ ] **Step 3: Commit**

```bash
git add template/.claude/agents/aside-researcher.md
git commit -m "feat: add aside-researcher agent definition"
```

---

### Task 2: Create the /aside skill

**Files:**
- Create: `template/.claude/skills/aside/SKILL.md`

This is the main deliverable. The skill handles argument parsing, quick mode execution, and research mode dispatch.

- [ ] **Step 1: Create the skill directory and file**

```markdown
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
- Files always go to `shared-context/{user}/` (never inflight)
- No interaction with the inflight tracker
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
```

- [ ] **Step 2: Verify the file was written correctly**

Run: `cat template/.claude/skills/aside/SKILL.md | head -5`
Expected: The YAML frontmatter opening with `---` and `name: aside`

- [ ] **Step 3: Commit**

```bash
git add template/.claude/skills/aside/SKILL.md
git commit -m "feat: add /aside skill for drive-by idea capture"
```

---

### Task 3: Update braindump skill to deprecate side variant

**Files:**
- Modify: `template/.claude/skills/braindump/SKILL.md:10-13` (Parameters section)
- Modify: `template/.claude/skills/braindump/SKILL.md:62-70` (Flow: Side Braindump section)

The `side` variant in braindump should redirect to `/aside` rather than silently doing something different.

- [ ] **Step 1: Update the Parameters section**

Replace the current Parameters block (lines 10-13):

```markdown
## Parameters
- `/braindump {name}` — create or update a named braindump
- `/braindump side {name}` — capture an idea unrelated to current work
- `/braindump` (no param) — analyze session and suggest name(s)
```

With:

```markdown
## Parameters
- `/braindump {name}` — create or update a named braindump
- `/braindump` (no param) — analyze session and suggest name(s)

> **Note:** `/braindump side` has moved to `/aside`. If the user invokes `/braindump side`, redirect them: "The side braindump is now `/aside`. Running it for you." Then invoke the `/aside` skill with their text.
```

- [ ] **Step 2: Replace the Flow: Side Braindump section**

Replace the current "Flow: Side Braindump" section (lines 62-70):

```markdown
## Flow: Side Braindump (deprecated)

`/braindump side` has been replaced by the `/aside` skill. If invoked:
1. Inform the user: "The side braindump is now `/aside`. Running it for you."
2. Invoke the `/aside` skill with the user's text
```

- [ ] **Step 3: Verify the changes**

Run: `grep -n "aside" template/.claude/skills/braindump/SKILL.md`
Expected: References to `/aside` in the Parameters note and the deprecated Flow section

- [ ] **Step 4: Commit**

```bash
git add template/.claude/skills/braindump/SKILL.md
git commit -m "refactor: deprecate /braindump side in favor of /aside"
```

---

### Task 4: Copy new files to the active workspace

**Files:**
- Create: `.claude/agents/aside-researcher.md` (copy from template)
- Create: `.claude/skills/aside/SKILL.md` (copy from template)
- Modify: `.claude/skills/braindump/SKILL.md` (apply same changes as Task 3)

The template is the source of truth for new workspaces, but the current workspace also needs the files for immediate use.

- [ ] **Step 1: Copy the agent definition**

```bash
cp template/.claude/agents/aside-researcher.md .claude/agents/aside-researcher.md
```

Verify: `diff template/.claude/agents/aside-researcher.md .claude/agents/aside-researcher.md`
Expected: No differences

- [ ] **Step 2: Copy the skill**

```bash
mkdir -p .claude/skills/aside
cp template/.claude/skills/aside/SKILL.md .claude/skills/aside/SKILL.md
```

Verify: `diff template/.claude/skills/aside/SKILL.md .claude/skills/aside/SKILL.md`
Expected: No differences

- [ ] **Step 3: Apply braindump deprecation to workspace copy**

Apply the same edits from Task 3 to `.claude/skills/braindump/SKILL.md`.

Verify: `grep -n "aside" .claude/skills/braindump/SKILL.md`
Expected: Same references as the template version

- [ ] **Step 4: Commit workspace changes**

```bash
git add .claude/agents/aside-researcher.md .claude/skills/aside/SKILL.md .claude/skills/braindump/SKILL.md
git commit -m "chore: sync aside skill and braindump deprecation to workspace"
```

---

### Task 5: Manual smoke test

No automated tests — these are declarative skill/agent files. Verification is manual invocation.

- [ ] **Step 1: Test quick mode**

Invoke `/aside --quick test note about something random` and verify:
- A `local-only-*.md` file was created in `shared-context/myron/`
- The file has correct frontmatter (`variant: aside`)
- User's Original Thought section contains the verbatim text
- Further Investigation section has 2-3 bullet points

- [ ] **Step 2: Test research mode**

Invoke `/aside we should look into whether maintenance can auto-detect stale asides` and verify:
- The agent dispatches in the background
- A `local-only-*.md` file is created when the agent completes
- The file has all four sections: User's Original Thought, Agent Research, Synthesis, Further Investigation
- The user's original text is preserved verbatim

- [ ] **Step 3: Test braindump redirect**

Invoke `/braindump side test redirect` and verify:
- The user is informed about the `/aside` redirect
- The `/aside` skill is invoked with the text

- [ ] **Step 4: Clean up test files**

Delete any `local-only-*` test files created during smoke testing.
