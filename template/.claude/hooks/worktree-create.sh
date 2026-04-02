#!/usr/bin/env bash
set -euo pipefail

# WorktreeCreate hook for claude-workspace
# When a new worktree is created, scan for stale worktrees and flag them

WORKSPACE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPOS_DIR="$WORKSPACE_ROOT/repos"

stale=()

# Scan all repos for worktrees
for repo_dir in "$REPOS_DIR"/*/; do
  [[ -d "$repo_dir/.git" ]] || continue
  repo_name=$(basename "$repo_dir")
  # Skip worktrees themselves
  [[ "$repo_name" == *___wt-* ]] && continue

  # List worktrees for this repo
  while IFS= read -r line; do
    wt_path=$(echo "$line" | awk '{print $1}')
    wt_branch=$(echo "$line" | grep -oE '\[.*\]' | tr -d '[]')

    # Skip the main repo entry
    [[ "$wt_path" == "$repo_dir" ]] && continue
    [[ -z "$wt_path" ]] && continue

    # Check for recent activity
    if [[ -d "$wt_path" ]]; then
      last_commit_date=$(git -C "$wt_path" log -1 --format="%ci" 2>/dev/null || echo "")
      if [[ -n "$last_commit_date" ]]; then
        last_epoch=$(date -j -f "%Y-%m-%d %H:%M:%S %z" "$last_commit_date" "+%s" 2>/dev/null || date -d "$last_commit_date" "+%s" 2>/dev/null || echo "0")
        now_epoch=$(date "+%s")
        days_ago=$(( (now_epoch - last_epoch) / 86400 ))

        if [[ $days_ago -gt 3 ]]; then
          wt_name=$(basename "$wt_path")
          stale+=("- $wt_name ($wt_branch): no commits in ${days_ago} days")
        fi
      fi
    fi
  done < <(git -C "$repo_dir" worktree list 2>/dev/null)
done

if [[ ${#stale[@]} -gt 0 ]]; then
  message="Stale worktrees found:
$(printf '%s\n' "${stale[@]}")

Consider cleaning up with: git worktree remove {path}"
  output=$(echo "$message" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')
  echo "{\"additionalContext\": $output}"
else
  echo '{}'
fi
