# Coherent Revisions

When revising any document or code, rewrite the affected section from start to finish so the result reads as a single coherent piece. Never patch, inject, or insert new content between existing paragraphs/blocks in a way that creates a stitched-together feel.

This applies to all written output:
- Project documentation
- Specs and design docs
- Code and logic changes including comments
- Workspace-context files (handoffs, braindumps, locked truths)
- Release notes
- Open questions
- Commit messages

## Why

Injected revisions create fragmented, hard-to-follow output where the seams between old and new content are visible. Rewriting from start to finish produces output that flows naturally and reads as if written in one pass.

## In Practice

- When updating a section of a document, rewrite the entire section — not just the changed sentences
- When updating a workspace-context file, rewrite it as a fresh snapshot of current understanding
- When synthesizing multiple sources into release notes, write the narrative from scratch — don't concatenate
- When revising code with comments, ensure the comments tell a coherent story, not a changelog
- Small, isolated edits (fixing a typo, updating a single value) are fine — this rule targets substantive revisions
