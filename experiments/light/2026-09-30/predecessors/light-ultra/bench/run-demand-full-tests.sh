#!/bin/bash
set -euo pipefail
SSH=(ssh -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
while "${SSH[@]}" 'kill -0 3389956 2>/dev/null'; do sleep 20; done
"${SSH[@]}" '~/claude-agenc-work/light-ultra/bin/run-core-tests.sh 6ef8fc59a light-ultra-demand-full'
