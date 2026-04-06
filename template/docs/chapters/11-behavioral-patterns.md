# Behavioral Patterns

The workspace provides tools. This chapter tells you when to reach for them. These are not rules Claude enforces — they are practices that make the conventions work. The difference matters: a rule is a constraint that applies automatically. A pattern is a habit that you build deliberately.

Each pattern below describes the practice, why it matters, and what goes wrong when you skip it.

---

## One Topic, One File

**The practice:** When capturing context — braindumps, handoffs, any shared context file — put one topic in one file. If you are capturing two topics, create two files.

**Why it matters:** Different topics have different lifecycles. An authentication design braindump might be promoted to locked context. A naming-ideas braindump might stay personal for months. If they are in the same file, you cannot promote one without carrying the other. You cannot delete one without losing the other. You cannot search for one without reading through the other.

**What goes wrong:** One giant handoff file that grows every session. Six months later, it is 3,000 words covering five topics, three of which are obsolete. Nobody knows what is current. The file becomes noise that everyone scrolls past.

## Name Before Writing

**The practice:** Choose the file name before you start writing content. The name must describe the single topic. `auth-redesign.md`, not `session-notes.md`. `naming-ideas.md`, not `stuff-to-think-about.md`.

**Why it matters:** The name forces you to identify what the file is about. If you cannot name it cleanly, you are probably conflating topics — which means you should split into multiple files. The discipline of naming first is the discipline of thinking clearly about what you are capturing.

**What goes wrong:** Files named by date (`2026-04-05-notes.md`) or by session (`session-3-handoff.md`) that tell you nothing about their content. You end up with a directory of files that you have to open and read to know what they contain.

## Rewrite, Don't Append

**The practice:** When updating a shared context file across sessions, rewrite the affected section from start to finish. Do not append new paragraphs below old ones. Do not insert text between existing blocks. The result should read as if written in one sitting.

**Why it matters:** Appended content creates a geological record — layers of additions from different sessions with different contexts. The seams between old and new content are visible. Contradictions accumulate when an old paragraph says one thing and a new paragraph says another. The file becomes harder to read with every update.

**What goes wrong:** A handoff that says "we decided to use JWT" in paragraph 3 and "we switched to session cookies" in paragraph 8. Both are true at different points in time, but a reader encounters them as contradictions. The file's meaning becomes ambiguous.

The coherent-revisions rule enforces this for Claude. But you are the one deciding when to update a file versus create a new one. When the topic has evolved significantly, rewrite. When it is a new topic, create a new file.

## Braindump When You Hear "We Decided..."

**The practice:** When a conversation produces a decision — "we decided to use PostgreSQL," "we decided to split the API into two services," "we decided the MVP does not need real-time updates" — that is the signal to capture. Run `/braindump` or acknowledge the decision in whatever capture you are doing.

**Why it matters:** Decisions are the highest-value content in a conversation. Code can be re-read. Requirements can be re-derived. But the reasoning behind a decision — what alternatives were considered, what tradeoffs were weighed, why option B was rejected — exists only in the conversation where it happened. If you do not capture it, it is gone after the chat session ends.

**What goes wrong:** Three months later, someone asks "why did we use PostgreSQL instead of DynamoDB?" Nobody remembers. The decision gets relitigated. The same tradeoff discussion happens again, possibly reaching a different conclusion because the original constraints are forgotten.

## Keep Locked Context Lean

**The practice:** Target under 10KB total for `shared-context/locked/`. This is roughly 2,500 tokens. Every file in locked is read on every turn and injected into every subagent.

**Why it matters:** Locked context occupies the highest-priority position in the context window. It costs tokens on every interaction. A 20KB locked directory does not break anything, but it displaces conversation history and tool results — the context that makes Claude's responses relevant to what you are actually doing right now.

**What goes wrong:** Locked context grows to 50KB because every braindump that seems important gets promoted. Claude's responses become slower and more expensive. Subagent dispatches become token-heavy. The signal-to-noise ratio drops — Claude is reading 50KB of "team knowledge" on every turn, most of which is not relevant to the current task.

The `/release` skill's synthesis cycle is the natural pressure valve. It distills verbose ephemerals into concise locked entries. Use it.

## Clean Up Your Ephemerals

**The practice:** After a release, review your user-scoped context (`shared-context/{user}/`). For each file, decide: promote to locked (if the team needs it), keep as personal reference, or delete.

**Why it matters:** User-scoped context accumulates naturally during development. Braindumps, handoffs, research notes, design explorations — they pile up. After a release, some of this content is obsolete (superseded by the release notes), some is still relevant (ongoing reference), and some should become team knowledge (promote to locked). Without periodic cleanup, the directory becomes a graveyard of stale files that add noise to searches and confuse Claude when it reads shared context.

**What goes wrong:** Twelve ephemerals in your user directory, eight of which reference features that shipped two versions ago. Claude reads them during context gathering and surfaces outdated information. `/maintenance` flags them as stale but cannot delete them without your approval.

## Don't Skip Capture on Discussion Sessions

**The practice:** If a conversation produced insights, decisions, or design direction — even if no code was written, no branch was created — capture it. Run `/braindump` before ending the conversation.

**Why it matters:** Discussion sessions are where architecture gets shaped, priorities get set, and design direction gets established. These are high-value conversations. But because no code was written, they leave no trace in git. If you close the conversation without capturing, the reasoning is lost.

**What goes wrong:** A 45-minute architecture discussion produces no artifact. The next session starts with "what did we decide about the data model?" and nobody can reconstruct the reasoning. The discussion repeats.

## One Chat Session, One Work Session

**The practice:** Start a work session, do the work, complete or pause the session, end the conversation. Do not chain multiple work sessions in a single conversation. Finish one, start fresh.

**Why it matters:** Claude's context window has a fixed size. As a conversation grows, older messages are compacted — summaries replace the original content. A long conversation that chains multiple work sessions means the context from the first session is compressed or lost by the time you start the second. The inflight tracker captures key state, but the nuanced reasoning and discussion context degrades.

**What goes wrong:** You complete one feature and immediately start another in the same conversation. By the time you are deep into the second feature, Claude's memory of the first feature's decisions is compressed summaries. If something from the first session is relevant to the second, Claude may miss it or misremember it.

The SessionStart hook surfaces active sessions and handoffs at the beginning of each conversation. Let it do its job — start a fresh conversation for fresh work.

## Let PreCompact Nudge You

**The practice:** When the PreCompact hook fires (you will see Claude suggest capturing), stop and capture. The hook fires because the context window is getting full and compaction is about to remove older messages. This is your last chance to save context before it is compressed.

**Why it matters:** PreCompact fires while the full conversation is still available. Claude can read everything that was said and synthesize it into a braindump or handoff. After compaction, older messages are replaced with compressed summaries — the nuance is gone.

**What goes wrong:** You dismiss the capture suggestion and keep working. Compaction runs. Two minutes later, you realize you needed a detail from an earlier discussion. It is gone — replaced with a summary that says "discussed authentication approaches" without the specific tradeoffs that were analyzed.

---

## Key Takeaways

- One topic, one file. Name it before writing. Rewrite, don't append.
- Capture decisions when they happen — "we decided..." is the trigger.
- Keep locked context under 10KB. Use the release cycle as the pressure valve.
- Always capture discussion sessions, even if no code was written.
- One chat session, one work session. Start fresh for fresh work.
- When PreCompact nudges you, stop and capture. It is your last chance.
