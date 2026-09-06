# Memory and Placement Guidance

Where durable content goes, and what each destination costs.

## Where durable content goes

Eight destinations, ordered cheapest first. Work down and stop at the first that genuinely
fits. The right column is what every session pays, forever, for the choice.

| destination | for | always-loaded cost |
|---|---|---|
| nowhere | already covered, or true only today | zero |
| `.claude/rules/*.md` with `paths:` | an instruction that applies only to certain files | zero until a match is read |
| a skill | a procedure with steps, invoked on demand | its `description` line |
| auto-memory | machine-local preference or correction; not shared, not reviewable | one `MEMORY.md` line |
| `team-member/{user}/` | one person's working context | one index line, that user |
| `shared/` | team-visible reference, looked up when relevant | one index line |
| `shared/locked/` | canonical team truth | **the whole file, every session** |
| `.claude/rules/*.md` (no `paths:`) | an instruction that must hold in every session | **the whole file, every session** |

**`nowhere` is the most common correct answer.** A second copy in a second location is
worse than none — they drift, and the reader cannot tell which is current.

The two bold rows tax every session in this workspace, and anything shipped in the template
taxes every downstream workspace too. Reach them only after the cheaper rows are actually
ruled out. Prefer `paths:` for anything domain-specific: a rule about migration scripts does
not need to be in context while editing documentation.

**Before writing to either bold row, state the cost:**

```bash
node .claude/scripts/context-footprint.mjs --root . --add <bytes> --as <destination>
```

## The canonical test

Canonical describes what *is* and what *to do*, never what *to think*.

> If Claude read this for the first time during a session about an unrelated topic, would it
> (a) help frame the problem correctly, or (b) push it toward a particular answer to a
> question that hasn't been asked yet?

(a) is canonical. (b) is `shared/` at most, more often `team-member/{user}/`. Pre-loaded
conclusions don't read as opinions to Claude — they read as ground truth, and they frame
what Claude considers before the question is asked.

## Auto-memory specifically

Save: architecture decisions and their rationale, patterns that caused bugs, user
corrections about project conventions, external URLs and API quirks, tooling workarounds.

Don't save: temporary debugging state, file contents (re-read them), anything already in a
workspace-context file or a rule.

When a work session is active, session decisions and progress go in the session tracker
body at `work-sessions/{name}/workspace/session.md`, which `/complete-work` consumes.
Auto-memory is for what outlives the session. Never both.

For the full routing procedure, the frontmatter schema, the generator invocations, and the
belongs/doesn't-belong lists behind the canonical test, invoke the `context-placement`
skill.
