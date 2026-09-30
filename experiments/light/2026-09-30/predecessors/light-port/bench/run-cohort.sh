#!/bin/bash
set -euo pipefail
PHASE=${1:?phase}; BUILD=${2:?build}; TASKS=${3:-01-chunked-strict,04-count-by,06-key-rotation-map,12-partition-map}; REPEATS=${4:-1}; START=${5:-1}
CATALOG=${6:-0}
HARNESS=${7:-harness}
MODELS=${8:-deepseek-flash,deepseek-v4-pro}
[[ "$PHASE" =~ ^candidate-[a-z0-9-]+$ && "$BUILD" =~ ^core-[a-z0-9-]+$ && "$TASKS" =~ ^[a-z0-9,-]+$ && "$REPEATS" =~ ^[12]$ && "$START" =~ ^[12]$ ]]
[[ "$CATALOG" =~ ^[01]$ ]]
[[ "$HARNESS" =~ ^harness(-[a-z0-9]+)?$ ]]
[[ "$MODELS" == deepseek-flash || "$MODELS" == deepseek-v4-pro || "$MODELS" == deepseek-flash,deepseek-v4-pro ]]
python3 - "$PHASE" "$TASKS" "$MODELS" <<'PY'
import sys
phase,tasks,models=sys.argv[1:]
paths=['/work/runs/'+phase+'-'+model+'-'+task+'-light-r1/home/agenc/daemon.sock'
       for model in models.split(',') for task in tasks.split(',')]
invalid=[path for path in paths if len(path.encode())>=100]
if invalid:
    raise SystemExit('Unix socket path must remain below 100 bytes; use a shorter cohort label before launching any calls')
print('Socket-path preflight passed; maximum bytes='+str(max(map(lambda path:len(path.encode()),paths))))
PY
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" "docker run --rm --init -i --user 1000:1000 --cpus=2 --memory=4g -e AGENC_LIGHT_FULL_CATALOG=$CATALOG -v /home/paul/claude-agenc-work/light-port:/work -w /work node:26.5.0-bookworm python3 /work/$HARNESS/stdin_entry.py --root /work --core-base /work/core-shell --core-candidate /work/$BUILD --pi-prefix /work/pi --phase $PHASE --agents light --models $MODELS --tasks $TASKS --repeats $REPEATS --repeat-start $START --workers 2 --spend-cap-usd 15 --balance-floor-usd 10"
