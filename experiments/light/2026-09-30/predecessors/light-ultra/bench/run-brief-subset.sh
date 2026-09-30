#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
while true; do
  if "${SSH[@]}" 'grep -q "SQLite startup check passed" ~/claude-agenc-work/light-ultra/build-brief-final.log && grep -q "exit=0 end=" ~/claude-agenc-work/results/light-ultra-brief-focused-final.log && test "$(find "$HOME/claude-agenc-work/light-ultra/runs" -maxdepth 2 -path "*/candidate-round2-new-*/result.json" | wc -l)" -eq 32 && test "$(find "$HOME/claude-agenc-work/light-ultra/runs" -maxdepth 2 -path "*/candidate-round2-repeat2-*/result.json" | wc -l)" -eq 8 && test "$(find "$HOME/claude-agenc-work/light-ultra/runs" -maxdepth 2 -path "*/candidate-round2-confirm-screen-*/result.json" | wc -l)" -eq 8'; then break; fi
  sleep 20
done
"${SSH[@]}" 'python3 -' <<'PYVERIFY'
import pathlib,subprocess,fcntl
r=pathlib.Path.home()/'claude-agenc-work/light-ultra'
assert (r/'spend-deepseek.jsonl').resolve()==r/'spend-reconciled.jsonl'
assert not list((r/'runs').glob('candidate-brief-subset-*'))
assert subprocess.check_output(['git','-C',str(r/'core-brief-final'),'rev-parse','--short=9','HEAD']).decode().strip()=='df0f47246'
with (r/'locks/deepseek.lock').open('a') as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('Starting the brief-reasoning diagnostic after all48prior confirmation cells; every result remains retained.',flush=True)
PYVERIFY
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" 'docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-demand/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/core-brief-final --pi-prefix /work/pi --phase candidate-brief-subset --agents light --models deepseek-flash,deepseek-v4-pro --tasks 03-window-padding,07-source-manifest,09-separator-payload,12-partition-map --repeats 1 --workers 2 --spend-cap-usd 35 --balance-floor-usd 10'
