---
branch: chore/generalize-playwright-refs
type: chore
author: myron
date: 2026-04-22
---

## Generalize Playwright references in build-docs-site skill

The build-docs-site skill called out Playwright by name in two places — a pitfall bullet in `SKILL.md` and section 3 of `checklists/pitfalls.md`. The underlying issue (automated browser-automation viewport screenshots coming back blank for reasons rarely worth diagnosing) is not specific to Playwright; any browser automation tool with a viewport screenshot mode can exhibit it. The wording now describes the problem as "automated viewport screenshots can lie" and instructs the reader to use the tool's evaluate hook for DOM inspection, framed as a general workaround rather than a Playwright-specific one.

The fix itself is unchanged — full-page screenshots or DOM inspection via the automation tool's evaluate hook remain the recommended paths. Only the framing was tool-agnostic-ified.
