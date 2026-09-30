#!/bin/bash
set -euo pipefail
phase=${1:?}; build=${2:?}
[[ "$phase" =~ ^candidate-c[0-9]+$ && "$build" =~ ^core-converge-[a-z]+$ ]]
SSH=(ssh -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
# The frozen port's provider lock must be free before this study adds runs.
"${SSH[@]}" "python3 -c 'import fcntl; f=open(\"/home/paul/claude-agenc-work/light-port/locks/deepseek.lock\",\"a\"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)'"
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" "docker run --rm --init -i --user 1000:1000 --cpus=2 --memory=4g -v /home/paul/claude-agenc-work/light-ultra:/work -w /work node:26.5.0-bookworm python3 /work/converge/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/$build --pi-prefix /work/pi --phase $phase --agents light --models deepseek-flash --repeats 1 --workers 2 --spend-cap-usd 0 --balance-floor-usd 1"
