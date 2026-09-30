#!/bin/bash
set -euo pipefail
cd "$HOME/claude-agenc-work/light-runtime"
while docker inspect aafff185b0a972aedda9d9516ef7458ba480be6de6d2fd30a1bd6013b1382ec1 >/dev/null 2>&1; do sleep 15; done
sleep 2
python3 triage-r2.py
number=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  number=$((number+1))
  label=$(printf 'light-runtime-r2-alone-%02d' "$number")
  printf '%s\t%s\n' "$label" "$file" >> r2-rerun-map.tsv
  "$HOME/claude-agenc-work/bin/run-core-tests.sh" 36751015fdf7c4e2b45506f131d5025be7bcfbcc "$label" "$file"
done < r2-rerun-files.txt
printf 'reruns complete\n'
