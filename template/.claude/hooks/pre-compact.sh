#!/usr/bin/env bash
set -euo pipefail

# PreCompact hook for claude-workspace
# Fires before context compression — prompt user to capture before context is lost

WORKSPACE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SETTINGS_LOCAL="$WORKSPACE_ROOT/.claude/settings.local.json"

USER_NAME="unknown"
if [[ -f "$SETTINGS_LOCAL" ]]; then
  if command -v jq &>/dev/null; then
    USER_NAME=$(jq -r '.workspace.user // "unknown"' "$SETTINGS_LOCAL" 2>/dev/null || echo "unknown")
  else
    USER_NAME=$(node -e "console.log(require('$SETTINGS_LOCAL').workspace?.user || 'unknown')" 2>/dev/null || echo "unknown")
  fi
fi

message="Context is about to be compacted — earlier conversation details will be lost.

If this session produced decisions, design choices, or progress worth keeping:
  /braindump [name] — capture discussion and reasoning
  /handoff [name]   — capture workstream state and next steps

Files in shared-context/$USER_NAME/ will persist. Conversation details won't."

output=$(echo "$message" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
echo "{\"additionalContext\": $output}"
