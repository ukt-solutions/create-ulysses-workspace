---
name: promote
description: Move personal auto-memory or local-only files into shared context. Use when you've discovered something valuable that the team should know.
---

# Promote

Promote personal knowledge into shared context.

## Sources

This skill can promote from two sources:
1. **Auto-memory** — files in `~/.claude/projects/*/memory/`
2. **Local-only files** — `shared-context/local-only-*.md` or `.claude/rules/local-only-*.md`

## Flow

**Step 1: Choose source**
Ask: "What would you like to promote?"
- "Show my auto-memory files"
- "Show my local-only context files"
- "Show my local-only rules"

**Step 2: List candidates**
List files from the chosen source with their names, descriptions (from frontmatter), and a preview of content.

**Step 3: Select**
User picks which file(s) to promote.

**Step 4: Configure destination**
For each selected file, ask:
- "Name for this shared context?" (suggest based on source filename)
- "Team-visible, user-scoped, or keep as local-only?" (for promoting local-only to shared)
- "Locked (team truth, always loaded) or ephemeral (working knowledge)?"

**Step 5: Rewrite and save**
- Auto-memory files are terse notes — rewrite into the shared-context format with proper frontmatter, sections, and enough context to be useful to someone who wasn't in the original session.
- Local-only files: rename (drop `local-only-` prefix) or copy to new location.
- Set `type: promoted` in frontmatter.

**Step 6: Commit**
```bash
git add shared-context/{path-to-file}
git commit -m "promote: {name}"
```

**Step 7: Optionally remove source**
Ask: "Remove the original {source-type} file? [y/N]"
If auto-memory: delete the file from `~/.claude/projects/*/memory/`
If local-only: delete the local-only file

## Notes
- Promotion is one-way: shared context should not be demoted back to local-only
- Use this when you discover a pattern, convention, or decision that would benefit the team
- The rewrite step is important — auto-memory is written for Claude's internal use; shared context is written for humans and Claude
