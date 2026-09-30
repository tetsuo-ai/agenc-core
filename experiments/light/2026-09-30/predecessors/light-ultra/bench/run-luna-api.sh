#!/bin/bash
set -euo pipefail
phase=${1:?}; build=${2:?}; agents=${3:-pi,light}
[[ "$phase" =~ ^candidate-api-[a-z]+$ && "$build" =~ ^core-[a-z-]+$ && "$agents" =~ ^(pi|light|pi,light)$ ]]
source /Users/tetsuoarena/.config/agenc-keys/openai-luna.env
printf '%s\n' "$OPENAI_API_KEY" | ssh -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218 "docker run --rm --init -i --user 1000:1000 --cpus=2 --memory=4g -v /home/paul/claude-agenc-work/light-ultra:/work -w /work node:26.5.0-bookworm python3 /work/luna-api/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/$build --pi-prefix /work/pi --phase $phase --agents $agents --provider openai --models gpt-6-luna --workers 1 --spend-cap-usd 10 --balance-floor-usd 10 --repeats 2"
