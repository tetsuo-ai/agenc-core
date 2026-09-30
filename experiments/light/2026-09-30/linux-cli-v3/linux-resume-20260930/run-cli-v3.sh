#!/bin/bash
# Finite successor to the preserved cli-one failure. No paid network authority.
set -euo pipefail
gate=/home/paul/claude-agenc-work/light-final-20260930-xI3Mf6
image=sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271
phase=${1:?select build or parent}
case "$phase" in build|parent) ;; *) exit 2;; esac
container=light-final-20260930-xI3Mf6-cli-v3-$phase
options=(--init --name "$container" --user 1000:1000 --network none
  --memory=8g --memory-swap=8g --cpus=2 --pids-limit=512
  --cap-drop=ALL --security-opt=no-new-privileges
  -v "$gate:/gate" -v "$gate/source:/gate/source:ro"
  -v "$gate/fair:/gate/fair:ro" -e HOME=/gate/home -e TMPDIR=/gate/tmp)
if [[ "$phase" == build ]]; then
  docker run "${options[@]}" "$image" bash -lc '
    set -eu
    node /gate/fair/linux-build-v3/seal-inputs.mjs setup
    setup_pin=$(sha256sum /gate/setup-manifest-cli-v3.json | cut -d " " -f1)
    node /gate/fair/linux-parent-v2/setup.mjs /gate/setup-manifest-cli-v3.json "$setup_pin" /gate/cli-three
    node /gate/fair/linux-build-v3/seal-inputs.mjs build
    manifest_pin=$(sha256sum /gate/build-manifest-cli-v3.json | cut -d " " -f1)
    map_pin=$(sha256sum /gate/cli-three/build-map.json | cut -d " " -f1)
    node /gate/fair/linux-build-v3/build.mjs /gate/build-manifest-cli-v3.json "$manifest_pin" /gate/cli-three/build-map.json "$map_pin" /gate/cli-three/companion
    node /gate/fair/linux-build-v3/seal-inputs.mjs deployment
  ' > "$gate/logs/cli-v3-build.log" 2>&1
  tail -c 4000 "$gate/logs/cli-v3-build.log"
else
  pin=$(sha256sum "$gate/deployment-manifest-cli-v3.json" | cut -d ' ' -f1)
  docker run -d "${options[@]}" -v "$gate/cli-three/companion:/gate/cli-three/companion:ro" "$image" \
    node /gate/fair/linux-parent-v2/parent.mjs /gate/deployment-manifest-cli-v3.json "$pin"
  wait_status=0
  timeout 180s docker wait "$container" > "$gate/logs/cli-v3-parent.exit" || wait_status=$?
  if [[ "$wait_status" != 0 ]]; then docker stop -t 5 "$container"; fi
  docker logs "$container" > "$gate/logs/cli-v3-parent.log" 2>&1
  docker inspect --format '{{json .State}}' "$container" > "$gate/logs/cli-v3-parent.state.json"
  tail -c 4000 "$gate/logs/cli-v3-parent.log"
  cat "$gate/logs/cli-v3-parent.exit"
  exit "$wait_status"
fi
