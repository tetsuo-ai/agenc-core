#!/bin/bash
set -euo pipefail
cd "$HOME/claude-agenc-work/light-runtime"
run() {
  docker run --rm --init --user "$(id -u):$(id -g)" --cpus=2 --memory=4g \
    -v "$HOME/claude-agenc-work/light-runtime:/work" \
    -v "$HOME/claude-agenc-work/light-ultra:/evidence/light-ultra:ro" \
    -v "$HOME/claude-agenc-work/light-port:/evidence/light-port:ro" \
    -w /work node:26.5.0-bookworm python3 /work/replay.py "$@"
}
# Alternate order across tasks. Each pair uses identical recorded responses.
for task in 03-window-padding 07-source-manifest 09-separator-payload 12-partition-map; do
  case "$task" in
    03-*|09-*) order="before after" ;;
    *) order="after before" ;;
  esac
  for side in $order; do
    core=core-instrumented
    [ "$side" = after ] && core=core-candidate
    run --core "$core" --label matched-"$side" --tasks "$task" --modes cold,warm
  done
done
# An independent recorded sequence from the other benchmark job.
for side in before after; do
  core=core-instrumented
  [ "$side" = after ] && core=core-candidate
  run --core "$core" --label port-"$side" --tasks 09-separator-payload --modes warm \
    --traces /evidence/light-port/runs --prefix candidate-local-confirmation-deepseek-flash
done
for side in before after; do
  core=core-instrumented
  [ "$side" = after ] && core=core-candidate
  run --core "$core" --label syscall-"$side" --tasks 09-separator-payload --modes warm --native-io /work/native-io.so
done
for label in matched-before matched-after port-before port-after syscall-before syscall-after; do
  python3 summarize.py replay-runs "$label" > "$label-summary.json"
done
