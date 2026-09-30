#!/bin/bash
# New fixed-policy evaluation only. Historical harness and stopped attempts stay intact.
# This entry point does not clear any stop, lock, admission or reservation.
set -euo pipefail
phase=${1:?fresh candidate-api phase required}
build=${2:?frozen core build required}
tasks=${3:-01-chunked-strict,02-split-limit,03-window-padding,04-count-by,05-empty-refactor,06-key-rotation-map,07-source-manifest,08-integer-encoding,09-separator-payload,10-expiry-boundary,11-compression-marker,12-partition-map}
[[ "$phase" =~ ^candidate-api-[a-z]+$ && "$build" =~ ^core-[a-z-]+$ ]]
[[ "$tasks" =~ ^[a-z0-9,-]+$ ]]
source /Users/tetsuoarena/.config/agenc-keys/openai-luna.env
printf '%s\n' "$OPENAI_API_KEY" | ssh -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes paul@192.168.1.218 "docker run --rm --init -i --user 1000:1000 --cpus=2 --memory=4g -v /home/paul/claude-agenc-work/light-ultra:/work -w /work node:26.5.0-bookworm python3 /work/luna-api-fixed-policy/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/$build --pi-prefix /work/pi --phase $phase --agents light --provider openai --models gpt-6-luna --tasks $tasks --openai-reasoning-replay --reasoning-summary auto --workers 1 --spend-cap-usd 0 --balance-floor-usd 1 --repeats 1"
