#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
while ! "${SSH[@]}" 'test "$(find "$HOME/claude-agenc-work/light-ultra/runs" -maxdepth 2 -path "*/candidate-luna-full-*/result.json" | wc -l)" -eq 46'; do sleep 20; done
"${SSH[@]}" 'python3 -' <<'PY'
import pathlib,json,fcntl,urllib.request
r=pathlib.Path.home()/'claude-agenc-work/light-ultra'
assert not list((r/'runs').glob('candidate-luna-replay-*'))
with (r/'locks/openai.lock').open('a') as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
h=json.load(urllib.request.urlopen('http://127.0.0.1:8809/v1/proxy-health',timeout=15));assert h.get('status')=='ok'
ids=set()
for p in (r/'spend-luna.jsonl',r/'luna-admissions.jsonl'):
 for l in p.read_text().splitlines():
  x=json.loads(l);ids.add((x['run'],x['call']))
assert len(ids)<600
print(json.dumps({'replay_ablation':'starting','used_calls':len(ids),'remaining':600-len(ids)}),flush=True)
PY
"${SSH[@]}" 'docker run --rm --init -i --network host --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-luna/runner.py --root /work --core-base /work/core-base --core-candidate /work/core-frames-final --pi-prefix /work/pi --provider openai --models gpt-6-luna --workers 1 --phase candidate-luna-replay --agents light --tasks 03-window-padding,07-source-manifest,09-separator-payload,12-partition-map --repeats 1 --openai-reasoning-replay --spend-cap-usd 35 --balance-floor-usd 10'
