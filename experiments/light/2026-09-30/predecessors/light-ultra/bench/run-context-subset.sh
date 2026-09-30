#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
while true; do
  ready=$("${SSH[@]}" 'python3 - <<'"'"'PY'"'"'
import pathlib,fcntl
root=pathlib.Path.home()/"claude-agenc-work/light-ultra"
count=len(list((root/"runs").glob("candidate-lean-subset-*/result.json")))
free=False
with (root/"locks/deepseek.lock").open("a") as handle:
 try:
  fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB);free=True
 except BlockingIOError:pass
print("ready" if count==8 and free else "waiting")
PY')
  if [ "$ready" = ready ]; then break; fi
  sleep 20
done
"${SSH[@]}" 'python3 - <<'"'"'PY'"'"'
from pathlib import Path
root=Path.home()/"claude-agenc-work/light-ultra"
assert (root/"spend-deepseek.jsonl").resolve()==root/"spend-reconciled.jsonl"
assert not list((root/"runs").glob("candidate-context-subset-*")), "Subset already started"
assert "4fac1c7a2" in (root/"build-context.log").read_text()
assert "verified @tetsuo-ai/runtime entrypoints" in (root/"build-context.log").read_text()
print("Eight lean subset results retained; context subset uses complete study ledger",flush=True)
PY'
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" \
 'docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-next/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/core-context --pi-prefix /work/pi --phase candidate-context-subset --agents light --models deepseek-flash,deepseek-v4-pro --tasks 01-chunked-strict,04-count-by,06-key-rotation-map,12-partition-map --repeats 1 --workers 2 --spend-cap-usd 25 --balance-floor-usd 10'
