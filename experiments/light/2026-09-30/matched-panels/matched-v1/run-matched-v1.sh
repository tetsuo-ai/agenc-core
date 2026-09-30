#!/bin/bash
# Launch matched-v1 on the Linux PC. The key travels only on ssh stdin to
# stdin_entry.py; it is never on argv, in a file on the PC, or in logs.
# Container: pinned gate image, nonroot, 2 CPUs, 8 GiB without extra swap,
# 512 PIDs, all capabilities dropped, no-new-privileges. Network is required
# for the direct API. Light Core is mounted read-only.
set -euo pipefail
phase=${1:?matched phase required}; shift
[[ "$phase" =~ ^matched-[A-Za-z0-9_-]+$ ]]
image=sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271
work=/home/paul/claude-agenc-work/light-ultra
core=/home/paul/claude-agenc-work/light-final-20260930-xI3Mf6/source
remote=(docker run --rm --init -i --name "light-$phase" --user 1000:1000 --cpus=2 --memory=8g --memory-swap=8g
  --pids-limit=512 --cap-drop=ALL --security-opt=no-new-privileges
  -v "$work:/work" -v "$core:/core:ro" -w /work "$image"
  python3 /work/matched-v1/stdin_entry.py --root /work --light-core /core
  --light-commit 38d63e586a92c4da8b1e51b31d46f74ee359a55a --pi-prefix /work/pi --phase "$phase" "$@")
if [[ "${VALIDATE_ONLY:-0}" == 1 ]]; then
  printf 'validate-only-no-key\n' | /Users/tetsuoarena/claude-agenc/pc-ssh/pc.sh "${remote[*]} --validate-only"
else
  ( set +x; source /Users/tetsuoarena/.config/agenc-keys/openai-luna.env; printf '%s\n' "$OPENAI_API_KEY" ) \
    | /Users/tetsuoarena/claude-agenc/pc-ssh/pc.sh "${remote[*]}"
fi
