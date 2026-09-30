#!/bin/bash
# Linux startup profile of headless `agenc -p --light` inside the benchmark container
# (same image, limits and nested-bwrap options as matched-v3). Fake loopback provider only.
set -euo pipefail
label=${1:?label}; count=${2:-6}
core=${LIGHT_CORE_DIR:-/home/paul/claude-agenc-work/light-final-20260930-xI3Mf6/source}
dir=/home/paul/claude-agenc-work/light-ultra/startup-profile-linux
test -z "$(docker ps -q)" || { echo "refusing: containers running"; exit 3; }
docker run --rm --init --name startup-profile-$label --user 1000:1000 --cpus=2 --memory=8g --memory-swap=8g \
  --pids-limit=512 --cap-drop=ALL --security-opt=no-new-privileges \
  --security-opt=seccomp=unconfined --security-opt=apparmor=unconfined --security-opt=systempaths=unconfined \
  --network none -v "$dir:/prof" -v "$core:/core:ro" -w /prof \
  sha256:e0b8e458804294ea55ba65468b72514aee791b0e3cde3daf1b3f1f04ba883dd9 node bench-linux.mjs "$label" "$count"
