#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
base='docker run --rm --init -i --network host --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-luna/runner.py --root /work --core-base /work/core-base --core-candidate /work/core-frames-final --pi-prefix /work/pi --provider openai --models gpt-6-luna --workers 1 --spend-cap-usd 35 --balance-floor-usd 10'
# Preserve the two finished Pi r1 cells (01 and 04) and run only missing slots.
"${SSH[@]}" "$base --phase candidate-luna-full-r1 --agents pi,light --tasks 02-split-limit,03-window-padding,05-empty-refactor,06-key-rotation-map,07-source-manifest,08-integer-encoding,09-separator-payload,10-expiry-boundary,11-compression-marker,12-partition-map --repeats 1"
"${SSH[@]}" "$base --phase candidate-luna-full-r2 --agents pi,light --repeats 1 --repeat-start 2"
"${SSH[@]}" "$base --phase candidate-luna-full-light-r1 --agents light --tasks 01-chunked-strict,04-count-by --repeats 1"
