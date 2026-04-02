#!/usr/bin/env bash
set -euo pipefail

# SessionEnd hook for claude-workspace
# Logs session summary to .claude-scratchpad/session-log.jsonl

WORKSPACE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRATCHPAD="$WORKSPACE_ROOT/.claude-scratchpad"
LOG_FILE="$SCRATCHPAD/session-log.jsonl"
SETTINGS_LOCAL="$WORKSPACE_ROOT/.claude/settings.local.json"

# Read hook input from stdin
input=$(cat)

# Extract reason from hook data
reason=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('reason','unknown'))" 2>/dev/null || echo "unknown")

# Get user identity
USER_NAME="unknown"
if [[ -f "$SETTINGS_LOCAL" ]]; then
  if command -v jq &>/dev/null; then
    USER_NAME=$(jq -r '.workspace.user // "unknown"' "$SETTINGS_LOCAL" 2>/dev/null || echo "unknown")
  else
    USER_NAME=$(node -e "console.log(require('$SETTINGS_LOCAL').workspace?.user || 'unknown')" 2>/dev/null || echo "unknown")
  fi
fi

# Get current date
DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Check workspace branch
WORKSPACE_BRANCH=$(git -C "$WORKSPACE_ROOT" branch --show-current 2>/dev/null || echo "unknown")

# Ensure scratchpad exists
mkdir -p "$SCRATCHPAD"

# Append session summary
echo "{\"event\":\"session_end\",\"date\":\"$DATE\",\"user\":\"$USER_NAME\",\"reason\":\"$reason\",\"workspace_branch\":\"$WORKSPACE_BRANCH\"}" >> "$LOG_FILE"

echo '{}'
