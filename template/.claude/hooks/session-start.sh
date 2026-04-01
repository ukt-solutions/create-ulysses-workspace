#!/usr/bin/env bash
set -euo pipefail

# SessionStart hook for claude-workspace
# Reads workspace.json, syncs repos, surfaces active context

WORKSPACE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKSPACE_JSON="$WORKSPACE_ROOT/workspace.json"
CONTEXT_DIR="$WORKSPACE_ROOT/shared-context"
REPOS_DIR="$WORKSPACE_ROOT/repos"

context_lines=()

# Check if workspace.json exists
if [[ ! -f "$WORKSPACE_JSON" ]]; then
  echo '{"additionalContext": "No workspace.json found. Run /setup to initialize this workspace."}'
  exit 0
fi

# Parse workspace config (requires jq or node)
if command -v jq &>/dev/null; then
  WORKSPACE_NAME=$(jq -r '.workspace.name // "unnamed"' "$WORKSPACE_JSON")
  REPOS=$(jq -r '.repos | keys[]' "$WORKSPACE_JSON" 2>/dev/null || true)
else
  # Fallback: use node for JSON parsing
  WORKSPACE_NAME=$(node -e "console.log(require('$WORKSPACE_JSON').workspace?.name || 'unnamed')" 2>/dev/null || echo "unnamed")
  REPOS=$(node -e "Object.keys(require('$WORKSPACE_JSON').repos || {}).forEach(k => console.log(k))" 2>/dev/null || true)
fi

context_lines+=("Workspace: $WORKSPACE_NAME")

# Check repos status
missing_repos=()
existing_repos=()
if [[ -n "$REPOS" ]]; then
  while IFS= read -r repo; do
    if [[ -d "$REPOS_DIR/$repo" ]]; then
      existing_repos+=("$repo")
      # Pull latest (non-blocking)
      (cd "$REPOS_DIR/$repo" && git fetch --quiet 2>/dev/null) &
    else
      missing_repos+=("$repo")
    fi
  done <<< "$REPOS"
  wait
fi

if [[ ${#missing_repos[@]} -gt 0 ]]; then
  context_lines+=("Missing repos: ${missing_repos[*]}. Run /setup to clone them.")
fi
if [[ ${#existing_repos[@]} -gt 0 ]]; then
  context_lines+=("Repos synced: ${existing_repos[*]}")
fi

# Surface active shared-context entries
if [[ -d "$CONTEXT_DIR" ]]; then
  active_entries=()
  while IFS= read -r -d '' file; do
    basename=$(basename "$file" .md)
    # Skip locked dir, .keep files, local-only files
    [[ "$basename" == ".keep" ]] && continue
    [[ "$basename" == local-only-* ]] && continue
    [[ "$file" == */locked/* ]] && continue

    # Read frontmatter for lifecycle status
    lifecycle="active"
    if head -5 "$file" | grep -q "^lifecycle:"; then
      lifecycle=$(head -10 "$file" | grep "^lifecycle:" | sed 's/lifecycle: *//')
    fi

    # Get modification time (portable)
    if [[ "$(uname)" == "Darwin" ]]; then
      mtime=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$file")
    else
      mtime=$(stat -c "%y" "$file" | cut -d. -f1)
    fi

    # Extract topic from frontmatter or filename
    topic="$basename"
    if head -5 "$file" | grep -q "^topic:"; then
      topic=$(head -10 "$file" | grep "^topic:" | sed 's/topic: *//')
    fi

    # Get relative path for user-scoped detection
    relpath="${file#$CONTEXT_DIR/}"

    active_entries+=("- $topic ($lifecycle, updated $mtime) — $relpath")
  done < <(find "$CONTEXT_DIR" -maxdepth 2 -name "*.md" -not -path "*/locked/*" -print0 2>/dev/null | sort -z)

  if [[ ${#active_entries[@]} -gt 0 ]]; then
    context_lines+=("")
    context_lines+=("Active shared context:")
    for entry in "${active_entries[@]}"; do
      context_lines+=("$entry")
    done
    context_lines+=("")
    context_lines+=("Use /start-work handoff to resume, or /start-work blank for new work.")
  fi
fi

# Build JSON output
output=$(printf '%s\n' "${context_lines[@]}")
# Escape for JSON
output=$(echo "$output" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')

echo "{\"additionalContext\": $output}"
