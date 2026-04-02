#!/usr/bin/env bash
set -euo pipefail

# PreToolUse hook for claude-workspace
# Detects writes to repos/ without an active work session (worktree/branch)
# Reads tool name and input from stdin as JSON

WORKSPACE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPOS_DIR="$WORKSPACE_ROOT/repos"

# Read hook input from stdin
input=$(cat)

# Extract tool name
tool_name=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")

# Only check file-writing tools
case "$tool_name" in
  Bash|Edit|Write) ;;
  *) echo '{}'; exit 0 ;;
esac

# Extract the input/arguments to find file paths
tool_input=$(echo "$input" | python3 -c "
import sys, json
d = json.load(sys.stdin)
inp = d.get('tool_input', {})
# Check common path fields
paths = []
if isinstance(inp, dict):
    for key in ['file_path', 'command', 'path']:
        if key in inp:
            paths.append(str(inp[key]))
print(' '.join(paths))
" 2>/dev/null || echo "")

# Check if any path references repos/
if ! echo "$tool_input" | grep -q "repos/"; then
  echo '{}'
  exit 0
fi

# Extract which repo is being written to
repo_match=$(echo "$tool_input" | grep -oE "repos/[^/___]+" | head -1 | sed 's|repos/||')
if [[ -z "$repo_match" ]]; then
  echo '{}'
  exit 0
fi

# Check if this is a worktree (has ___wt- in the path) — that's fine
if echo "$tool_input" | grep -q "___wt-"; then
  echo '{}'
  exit 0
fi

# Check if we're on the default branch of that repo
if [[ -d "$REPOS_DIR/$repo_match" ]]; then
  current_branch=$(git -C "$REPOS_DIR/$repo_match" branch --show-current 2>/dev/null || echo "")
  default_branch=$(git -C "$REPOS_DIR/$repo_match" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo "main")

  if [[ "$current_branch" == "$default_branch" || "$current_branch" == "main" || "$current_branch" == "master" ]]; then
    message="You're writing to repos/$repo_match on its default branch ($current_branch). Changes should go through a worktree on a feature branch. Consider running /start-work to formalize this as a work session."
    output=$(echo "$message" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')
    echo "{\"additionalContext\": $output}"
    exit 0
  fi
fi

echo '{}'
