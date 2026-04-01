#!/usr/bin/env bash
set -euo pipefail

# SubagentStart hook for claude-workspace
# Injects shared-context/locked/ files into subagent context

WORKSPACE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKSPACE_JSON="$WORKSPACE_ROOT/workspace.json"
LOCKED_DIR="$WORKSPACE_ROOT/shared-context/locked"

# Default max size: 10KB
MAX_BYTES=10240
if [[ -f "$WORKSPACE_JSON" ]]; then
  if command -v jq &>/dev/null; then
    custom_max=$(jq -r '.workspace.subagentContextMaxBytes // empty' "$WORKSPACE_JSON" 2>/dev/null || true)
  else
    custom_max=$(node -e "console.log(require('$WORKSPACE_JSON').workspace?.subagentContextMaxBytes || '')" 2>/dev/null || true)
  fi
  if [[ -n "$custom_max" ]]; then
    MAX_BYTES="$custom_max"
  fi
fi

# Check if locked directory has content
if [[ ! -d "$LOCKED_DIR" ]]; then
  echo '{}'
  exit 0
fi

locked_files=()
while IFS= read -r -d '' file; do
  [[ "$(basename "$file")" == ".keep" ]] && continue
  locked_files+=("$file")
done < <(find "$LOCKED_DIR" -name "*.md" -print0 2>/dev/null | sort -z)

if [[ ${#locked_files[@]} -eq 0 ]]; then
  echo '{}'
  exit 0
fi

# Concatenate locked context files
context=""
for file in "${locked_files[@]}"; do
  name=$(basename "$file" .md)
  content=$(cat "$file")
  context+="
--- ${name} ---
${content}
"
done

# Check size
byte_count=${#context}
if [[ $byte_count -gt $MAX_BYTES ]]; then
  # Inject summary instead of full content
  file_list=""
  for file in "${locked_files[@]}"; do
    name=$(basename "$file" .md)
    first_line=$(head -1 "$file" | sed 's/^#* *//')
    file_list+="- ${name}: ${first_line}\n"
  done
  context="[Locked shared context exceeds ${MAX_BYTES} byte limit (${byte_count} bytes). Summary of ${#locked_files[@]} files:]
$(echo -e "$file_list")
[Read individual files from shared-context/locked/ if you need full content.]"
fi

# Build JSON output
output=$(echo "$context" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
echo "{\"additionalContext\": $output}"
