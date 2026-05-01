#!/usr/bin/env bash
# Wire the agenc-core git hooks for the local checkout.
#
# Sets git's hooksPath config (local to this repo) so that anything in
# scripts/git-hooks/ runs as the named hook. Idempotent — safe to re-run.
#
# Each developer opts in once. CI does not need to run this.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$REPO_ROOT/scripts/git-hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "error: $HOOKS_DIR not found — run from inside agenc-core" >&2
  exit 1
fi

# Make every hook executable
chmod +x "$HOOKS_DIR"/* 2>/dev/null || true

# Configure local git to use the directory
git config --local core.hooksPath "scripts/git-hooks"

echo "git hooks installed:"
ls "$HOOKS_DIR" | sed 's/^/  /'
echo
echo "skip a hook for a single commit with: git commit --no-verify"
echo "uninstall with: git config --local --unset core.hooksPath"
