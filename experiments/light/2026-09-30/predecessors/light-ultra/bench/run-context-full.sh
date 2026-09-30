#!/bin/bash
set -euo pipefail
ssh -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218 'bash -s' <<'REMOTE'
set -euo pipefail
task_root="$HOME/claude-agenc-work/light-ultra"
results="$HOME/claude-agenc-work/results"
test ! -e "$results/light-ultra-context-full.log"
while ! tail -1 "$results/light-ultra-core-next-full.log" | grep -q '^exit=.* end='; do sleep 20; done
"$task_root/bin/run-core-tests.sh" light/result-bounds light-ultra-context-full
REMOTE
