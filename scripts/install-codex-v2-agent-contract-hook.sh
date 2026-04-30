#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
git_dir="$(git rev-parse --git-dir)"
hook_path="$git_dir/hooks/pre-commit"

mkdir -p "$(dirname "$hook_path")"

tmp_path="${hook_path}.tmp"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' ''
  printf '%s\n' 'repo_root="$(git rev-parse --show-toplevel)"'
  printf '%s\n' 'cd "$repo_root"'
  printf '%s\n' 'npm run validate:codex-v2-agent-contract --workspace=@tetsuo-ai/runtime'
} >"$tmp_path"

chmod +x "$tmp_path"
mv "$tmp_path" "$hook_path"

printf 'Installed Codex V2 agent contract pre-commit hook at %s\n' "$hook_path"
