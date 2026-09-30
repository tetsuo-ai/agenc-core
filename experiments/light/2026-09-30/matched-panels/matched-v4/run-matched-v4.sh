#!/bin/bash
# Launch matched-v4 on the Linux PC. The key travels only on ssh stdin to
# stdin_entry.py; it is never on argv, in a file on the PC, or in logs.
# Container: gate image plus bubblewrap, nonroot, 2 CPUs, 8 GiB without extra
# swap, 512 PIDs, all capabilities dropped, no-new-privileges. seccomp,
# AppArmor and masked /proc paths are relaxed only so AgenC's bubblewrap
# sandbox can create its namespaces and private /proc inside the container. Network is required
# for the direct API. Light Core is mounted read-only.
set -euo pipefail
phase=${1:?matched phase required}; shift
[[ "$phase" =~ ^matched-[A-Za-z0-9_-]+$ ]]
image=sha256:e0b8e458804294ea55ba65468b72514aee791b0e3cde3daf1b3f1f04ba883dd9  # gate image + bubblewrap 0.8
work=/home/paul/claude-agenc-work/light-ultra
core=${LIGHT_CORE_DIR:-/home/paul/claude-agenc-work/light-final-20260930-xI3Mf6/source}
commit=${LIGHT_COMMIT:-38d63e586a92c4da8b1e51b31d46f74ee359a55a}
remote=(docker run --rm --init -i --name "light-$phase" --user 1000:1000 --cpus=2 --memory=8g --memory-swap=8g
  --pids-limit=512 --cap-drop=ALL --security-opt=no-new-privileges
  --security-opt=seccomp=unconfined --security-opt=apparmor=unconfined --security-opt=systempaths=unconfined
  -e MATCHED_CONTAINER=gate-image+bwrap,nonroot,cap-drop-all,nnp,seccomp/apparmor/systempaths-unconfined-for-nested-bwrap,2cpu,8g,512pids
  -v "$work:/work" -v "$core:/core:ro" -w /work "$image"
  python3 /work/matched-v4/stdin_entry.py --root /work --light-core /core
  --light-commit "$commit" --pi-prefix /work/pi --phase "$phase" "$@")
if [[ "${VALIDATE_ONLY:-0}" == 1 ]]; then
  printf 'validate-only-no-key\n' | /Users/tetsuoarena/claude-agenc/pc-ssh/pc.sh "${remote[*]} --validate-only"
else
  ( set +x; source /Users/tetsuoarena/.config/agenc-keys/openai-luna.env; printf '%s\n' "$OPENAI_API_KEY" ) \
    | /Users/tetsuoarena/claude-agenc/pc-ssh/pc.sh "${remote[*]}"
fi
