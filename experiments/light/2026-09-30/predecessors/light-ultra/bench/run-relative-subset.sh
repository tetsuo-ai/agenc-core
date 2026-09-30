#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
while ! "${SSH[@]}" 'grep -q "SQLite startup check passed" ~/claude-agenc-work/light-ultra/build-relative.log && grep -q "exit=0 end=" ~/claude-agenc-work/results/light-ultra-relative-focused.log'; do sleep 20; done
"${SSH[@]}" 'python3 -' <<'PY'
import pathlib,subprocess,fcntl
r=pathlib.Path.home()/'claude-agenc-work/light-ultra'
assert not list((r/'runs').glob('candidate-rel-subset-*'))
assert subprocess.check_output(['git','-C',str(r/'core-relative'),'rev-parse','--short=9','HEAD']).decode().strip()=='720f29d9f'
assert (r/'spend-deepseek.jsonl').resolve()==r/'spend-reconciled.jsonl'
with (r/'locks/deepseek.lock').open('a') as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
PY
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" 'docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-demand/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/core-relative --pi-prefix /work/pi --phase candidate-rel-subset --agents light --models deepseek-flash,deepseek-v4-pro --tasks 07-source-manifest,09-separator-payload,12-partition-map --repeats 1 --workers 2 --spend-cap-usd 35 --balance-floor-usd 10'
