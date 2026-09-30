#!/bin/bash
set -euo pipefail
ssh -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218 'bash -s' <<'REMOTE'
set -euo pipefail
task_root="$HOME/claude-agenc-work/light-ultra"
results="$HOME/claude-agenc-work/results"
test ! -e "$results/light-ultra-batch-full.log"
while ! tail -1 "$results/light-ultra-context-full.log" | grep -q '^exit=.* end='; do sleep 20; done
test "$(git -C "$task_root/core-batch" rev-parse HEAD)" = 9e7edc3975cee8ca2225657193da4fa0c41b5e9d
test "$(git -C "$task_root/core-candidate" ls-remote origin refs/heads/light/result-bounds | cut -f1)" = 9e7edc3975cee8ca2225657193da4fa0c41b5e9d
"$task_root/bin/run-core-tests.sh" light/result-bounds light-ultra-batch-full
REMOTE
