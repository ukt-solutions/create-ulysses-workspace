#!/usr/bin/env bash
set -euo pipefail

# PostCompact hook for claude-workspace
# Fires after context compression — remind user that earlier context was lost

message="Earlier context was compacted. Discussion details from before this point may be incomplete.

If you had uncaptured decisions or progress, use /braindump or /handoff now while you still remember."

output=$(echo "$message" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
echo "{\"additionalContext\": $output}"
