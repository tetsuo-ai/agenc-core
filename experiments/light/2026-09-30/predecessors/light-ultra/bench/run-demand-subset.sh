#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
while true; do
  ready=$("${SSH[@]}" 'find "$HOME/claude-agenc-work/light-ultra/runs" -maxdepth 2 -path "*/candidate-catalog-subset-*/result.json" | wc -l')
  if [ "$ready" -eq 8 ]; then break; fi
  sleep 20
done
"${SSH[@]}" 'python3 -' <<'PY'
import pathlib,fcntl,subprocess
r=pathlib.Path.home()/'claude-agenc-work/light-ultra'
assert (r/'spend-deepseek.jsonl').resolve()==r/'spend-reconciled.jsonl'
assert not list((r/'runs').glob('candidate-demand-subset-*'))
assert subprocess.check_output(['git','-C',str(r/'core-demand'),'rev-parse','--short=9','HEAD']).decode().strip()=='6ef8fc59a'
assert 'verified @tetsuo-ai/runtime entrypoints' in (r/'build-demand-final.log').read_text()
assert 'OK' in (r/'packaged-demand-offline.log').read_text()
for label in ['light-ultra-demand-focused','light-ultra-demand-focused-final']:
 assert 'exit=0 end=' in (r.parent/'results'/f'{label}.log').read_text()
with (r/'locks/deepseek.lock').open('a') as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('Prior cells retained; demand subset uses complete study ledger.',flush=True)
PY
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" 'docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-demand/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/core-demand --pi-prefix /work/pi --phase candidate-demand-subset --agents light --models deepseek-flash,deepseek-v4-pro --tasks 01-chunked-strict,04-count-by,06-key-rotation-map,12-partition-map --repeats 1 --workers 2 --spend-cap-usd 35 --balance-floor-usd 10'
