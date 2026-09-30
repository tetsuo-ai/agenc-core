#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
while true; do
  if "${SSH[@]}" 'grep -q "verified @tetsuo-ai/runtime entrypoints" ~/claude-agenc-work/light-ultra/build-notice.log && grep -q "exit=0 end=" ~/claude-agenc-work/results/light-ultra-notice-focused-final.log'; then break; fi
  sleep 20
done
"${SSH[@]}" 'python3 -' <<'PY'
import pathlib,fcntl,subprocess
r=pathlib.Path.home()/'claude-agenc-work/light-ultra'
assert (r/'spend-deepseek.jsonl').resolve()==r/'spend-reconciled.jsonl'
assert len(list((r/'runs').glob('candidate-demand-subset-*/result.json')))==8
assert not list((r/'runs').glob('candidate-notice-subset-*'))
assert subprocess.check_output(['git','-C',str(r/'core-notice'),'rev-parse','--short=9','HEAD']).decode().strip()=='8d8505f2c'
assert 'verified @tetsuo-ai/runtime entrypoints' in (r/'build-notice.log').read_text()
with (r/'locks/deepseek.lock').open('a') as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('All prior cells retained; notice subset uses the complete study ledger.',flush=True)
PY
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" 'docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-demand/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/core-notice --pi-prefix /work/pi --phase candidate-notice-subset --agents light --models deepseek-flash,deepseek-v4-pro --tasks 01-chunked-strict,04-count-by,06-key-rotation-map,12-partition-map --repeats 1 --workers 2 --spend-cap-usd 35 --balance-floor-usd 10'
