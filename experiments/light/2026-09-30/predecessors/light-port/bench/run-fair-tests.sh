#!/bin/bash
set -euo pipefail
job_root=/home/paul/claude-agenc-work/light-port
while true; do
  count=$(find "$job_root/runs" -maxdepth 2 -path '*/candidate-eq-*/result.json' | wc -l)
  if [ "$count" = 48 ]; then break; fi
  sleep 20
done
# This study's suites start only after all benchmark cells have finished.
/home/paul/claude-agenc-work/bin/run-core-tests.sh light/pi-port-main light-port-fair-main-full
/home/paul/claude-agenc-work/bin/run-core-tests.sh light/pi-port light-port-fair-candidate-full
