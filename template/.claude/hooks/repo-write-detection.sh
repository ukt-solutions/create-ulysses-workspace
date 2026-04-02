#!/usr/bin/env bash
set -euo pipefail

# PreToolUse hook for claude-workspace
# Detects writes to repos/ worktrees without an active work session
# An active work session is indicated by .claude-scratchpad/.work-session-* files

WORKSPACE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRATCHPAD="$WORKSPACE_ROOT/.claude-scratchpad"

# Read hook input from stdin
input=$(cat)

# Extract tool name
tool_name=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")

# Only check file-writing tools
case "$tool_name" in
  Bash|Edit|Write) ;;
  *) echo '{}'; exit 0 ;;
esac

# Extract file paths from tool input
tool_input=$(echo "$input" | python3 -c "
import sys, json
d = json.load(sys.stdin)
inp = d.get('tool_input', {})
paths = []
if isinstance(inp, dict):
    for key in ['file_path', 'command', 'path']:
        if key in inp:
            paths.append(str(inp[key]))
print(' '.join(paths))
" 2>/dev/null || echo "")

# Only care about writes to repos/ worktrees
if ! echo "$tool_input" | grep -q "___wt-"; then
  echo '{}'
  exit 0
fi

# Check if any work session is active
if ls "$SCRATCHPAD"/.work-session-* 1>/dev/null 2>&1; then
  echo '{}'
  exit 0
fi

# No work session active but writing to a worktree
message="You're making changes to a worktree but no work session is active. Run /start-work to formalize this work session."
output=$(echo "$message" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')
echo "{\"additionalContext\": $output}"
