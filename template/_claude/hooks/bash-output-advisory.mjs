#!/usr/bin/env node
// PreToolUse hook — soft advisory for known-noisy bash commands.
//
// Does NOT modify the command. Emits a one-line additionalContext nudge so
// the model can choose to scope the command before executing. Patterns are
// deliberately narrow — false positives train the model to ignore the hook.
//
// Add patterns sparingly. The cost of a missed nudge is one bloated tool
// result; the cost of crying wolf is a permanently-ignored hook.
import { fileURLToPath } from 'url';
import { readStdin, respond } from './_utils.mjs';

// Only run the hook body when invoked directly (not when imported by tests).
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) {
  const input = await readStdin();
  if (input.tool_name !== 'Bash') {
    respond();
    process.exit(0);
  }

  const command = (input.tool_input?.command || '').trim();
  if (!command) {
    respond();
    process.exit(0);
  }

  const advisory = detectNoisyPattern(command);
  if (advisory) {
    respond(`Bash advisory: ${advisory} Consider scoping the command (path, filter, or pipe to head/tail/grep) before running.`);
  } else {
    respond();
  }
}

export function detectNoisyPattern(command) {
  // Already piped to a bounding command — caller knows what they're doing.
  if (/\|\s*(head|tail|grep|rg|wc|less|more)\b/.test(command)) return null;
  // Output already redirected to a file — not consuming context.
  if (/(?:^|\s)(?:>|>>|\|\s*tee)\s+\S/.test(command)) return null;

  // 1. Bare test runners with no scope.
  // Matches `npm test`, `npm run test`, `yarn test`, `pnpm test`, `bun test`, `cargo test`
  // followed by nothing, or only by recognized flags that don't constrain output.
  const testRunner = /^(?:npm(?:\s+run)?|yarn|pnpm|bun)\s+test\b(.*)$/.exec(command)
    || /^cargo\s+test\b(.*)$/.exec(command);
  if (testRunner) {
    const tail = testRunner[1];
    // A scope is any non-flag positional arg (path, filename, or test-name filter).
    // Flags that don't constrain output (--coverage, --watch, --verbose, --bail) don't count.
    const hasScope = tail.split(/\s+/).some(arg => arg && !arg.startsWith('-'));
    if (!hasScope) {
      return 'Bare test-runner invocation will produce all-tests output.';
    }
  }

  // 2. Recursive grep without an include filter.
  // Note: ripgrep (`rg`) is recursive by default and respects .gitignore, so a
  // bare `rg pattern .` is usually fine. We only flag classic `grep -r`.
  if (/^grep\s+(?:-\w*r\w*|-r\b|--recursive\b)/.test(command)
      && !/--include[=\s]|--exclude[=\s]/.test(command)) {
    return 'Recursive grep without --include can return thousands of matches.';
  }

  // 3. find on a home/root anchor without a name/path constraint.
  if (/^find\s+(?:\/|~|\$HOME|\$\{HOME\})(?:\s|$)/.test(command)
      && !/-(?:name|iname|path|ipath|regex)\b/.test(command)) {
    return 'find on a broad anchor without -name/-path enumerates the whole tree.';
  }

  // 4. cat on log-shaped files.
  if (/^cat\s+\S*\.(?:log|jsonl|ndjson)\b/.test(command)) {
    return 'Log-shaped files are often large.';
  }

  return null;
}
