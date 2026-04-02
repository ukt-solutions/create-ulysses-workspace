---
name: promote
description: Move personal auto-memory or local-only files into shared context. Use when you've discovered something valuable that the team should know.
---

# Promote

Promote personal knowledge into shared context. Assess all candidates, recommend actions, let the user decide with coded references.

## Sources

This skill can promote from three sources:
1. **Auto-memory (AM)** — files in `~/.claude/projects/*/memory/`
2. **Local-only context (LOC)** — `shared-context/local-only-*.md`
3. **Local-only rules (LOR)** — `.claude/rules/local-only-*.md`

## Flow

**Step 1: List all candidates**

Show ALL candidates from all sources in a single coded table. The user should see everything at once to make informed decisions.

```
| Code | File                          | Assessment                              | Recommendation    |
|------|-------------------------------|-----------------------------------------|-------------------|
| AM1  | feedback_no_injection_rev...  | Redundant — coherent-revisions rule     | Drop from memory  |
| AM2  | project_create_claude_work... | Stale — references deleted spec         | Drop or update    |
| AM3  | feedback_subagent_perms...    | Personal setup quirk                    | Keep as memory    |
| LOC1 | local-only-naming-ideas.md    | Team should see naming options          | Promote to myron/ |
| LOC2 | local-only-release-checkli... | Personal task tracker                   | Keep local        |
| LOR1 | local-only-dogfood-sync.md    | Dogfood-specific, not for template      | Keep local        |
```

For each candidate, assess:
- Is it redundant with an existing rule or context file? → recommend drop
- Is it stale or outdated? → recommend drop or update
- Is it personal/setup-specific? → recommend keep as-is
- Would the team benefit from seeing it? → recommend promote

**Step 2: User decides**

The user responds using codes:
- "Promote: LOC1, LOC2. Drop: AM1, AM2. Keep the rest."
- "Promote all LOC. Drop AM1-AM3."
- Or any combination.

**Step 3: Execute decisions**

For each **promote** action:
- Ask: "Team-visible, user-scoped (default), or locked?"
- Copy to destination, set `type: promoted` in frontmatter
- Remove the local-only original
- Commit individually: `git commit -m "promote: {name}"`

For each **drop** action:
- Delete the file (auto-memory from `~/.claude/projects/*/memory/`, local-only from workspace)
- Update MEMORY.md index if auto-memory was removed

For each **keep** action:
- No changes

**Step 4: Report**

"Promoted {N} files. Dropped {M} files. {K} files unchanged."

## Rewrite on Promote

Auto-memory files are terse notes written for Claude's internal use. When promoting to shared context, rewrite into proper format with:
- Frontmatter (state, lifecycle, type: promoted, topic, author, updated)
- Sections with enough context to be useful to someone who wasn't in the original session
- Local-only files may already be well-formatted — copy as-is if so, just update frontmatter

## Notes
- Promotion is one-way: shared context should not be demoted back to local-only
- Use this when you discover a pattern, convention, or decision that would benefit the team
- The coded table makes bulk decisions fast — no need to type full filenames
- Assess everything upfront so the user sees the full picture before deciding
