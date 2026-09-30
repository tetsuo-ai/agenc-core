#!/bin/bash
set -euo pipefail
cd "$HOME/claude-agenc-work/light-runtime"
while [ ! -s r3-paired-after-summary.json ]; do sleep 5; done
sha=e6d260717
fullsha=$(git -C "$HOME/claude-agenc-work/agenc-core" rev-parse "$sha")
wt="$HOME/claude-agenc-work/wt/${fullsha:0:12}"
run() {
  label=$1; shift
  "$HOME/claude-agenc-work/bin/run-core-tests.sh" light/runtime-fastpath "$label" "$@" > "$label-launch.log" 2>&1 &
  runner_pid=$!
  limited=""
  while kill -0 "$runner_pid" 2>/dev/null; do
    for cid in $(docker ps -q); do
      [ "$(docker inspect --format '{{.Config.WorkingDir}}' "$cid" 2>/dev/null)" = "$wt" ] || continue
      case " $limited " in *" $cid "*) continue;; esac
      docker update --cpus 2 "$cid" >/dev/null
      limited="$limited $cid"
    done
    sleep 5
  done
  wait "$runner_pid"
}
while ! grep -q "^exit=" "$HOME/claude-agenc-work/results/light-runtime-r3-full.log" 2>/dev/null; do sleep 5; done
python3 triage-r3.py > r3-triage-summary.log
number=0
: > r3-rerun-map.tsv
while IFS= read -r file; do
  [ -n "$file" ] || continue
  number=$((number+1))
  label=$(printf 'light-runtime-r3-alone-%02d' "$number")
  printf '%s\t%s\n' "$label" "$file" >> r3-rerun-map.tsv
  run "$label" "$file"
done < r3-rerun-files.txt
printf 'complete\n' > r3-triage-complete.txt
