#!/bin/bash
set -euo pipefail
cd "$HOME/claude-agenc-work/light-runtime"
run() {
  docker run --rm --init --user "$(id -u):$(id -g)" --cpus=2 --memory=4g \
    -v "$PWD:/work" \
    -v "$HOME/claude-agenc-work/light-ultra:/evidence/light-ultra:ro" \
    -v "$HOME/claude-agenc-work/light-port:/evidence/light-port:ro" \
    -w /work node:26.5.0-bookworm python3 /work/replay.py "$@"
}
for task in 03-window-padding 07-source-manifest 09-separator-payload 12-partition-map; do
  case "$task" in 03-*|09-*) order="before after";; *) order="after before";; esac
  for side in $order; do
    core=core-round1
    [ "$side" = after ] && core=core-candidate
    run --core "$core" --label r2-paired-"$side" --tasks "$task" --modes daemon,cold,warm
  done
done
for label in r2-paired-before r2-paired-after; do
  python3 summarize.py replay-runs "$label" > "$label-summary.json"
done
