# No Retry Loops

When a fix attempt fails, do not immediately try a variation of the same approach. Stop, diagnose, and research before trying again.

## The Rule

If you have tried a solution and it produced the same error or unexpected result twice, you are in a retry loop. Stop and do the following before writing any more code:

1. **State what you expected vs what happened.** Be specific — not "it didn't work" but "expected 200, got 403 with message X."
2. **Identify what you don't understand.** What assumption is failing? Why is the result surprising?
3. **Research the specific issue.** Read documentation, search for the error message, check the source code of the library or API you're calling. Use web search if local sources don't explain it.
4. **Present your findings.** Tell the user what you learned and what you now think the actual cause is. Propose a solution based on understanding, not guessing.

## What This Prevents

- Cycling through variations of the same broken approach
- Wasting tokens on trial-and-error when reading the docs would take one turn
- Confidently applying "fixes" without understanding the root cause
- The user having to say "stop and actually research this"

## When This Applies

- An error recurs after your first fix attempt
- The same test fails for a different-but-related reason after your change
- You find yourself adding workarounds instead of understanding why the original approach failed
- You're guessing at parameter values, config options, or API behavior instead of looking them up
