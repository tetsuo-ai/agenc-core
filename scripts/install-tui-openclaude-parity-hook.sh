#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"

git -C "$repo_root" config extensions.worktreeConfig true
git -C "$repo_root" config --worktree core.hooksPath .githooks

printf 'Installed worktree-local hooks path: %s\n' "$(git -C "$repo_root" config --worktree --get core.hooksPath)"
