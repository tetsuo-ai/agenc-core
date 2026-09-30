#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
# Deliberately not launched until a concrete selection is written after both subsets.
read -r chosen_tree chosen_sha < <(python3 - <<'PYSELECT'
import json,re
v=json.load(open('evidence/selected-candidate.json'))
assert v['tree'] in ('core-batch','core-focus')
assert re.fullmatch('[a-f0-9]{40}',v['sha'])
print(v['tree'],v['sha'])
PYSELECT
)
"${SSH[@]}" "python3 - '$chosen_tree' '$chosen_sha'" <<'PYCHECK'
import pathlib,fcntl,json,subprocess,sys
root=pathlib.Path.home()/'claude-agenc-work/light-ultra'
assert len(list((root/'runs').glob('candidate-focus-subset-*/result.json')))==8
assert len(list((root/'runs').glob('candidate-batch-subset-*/result.json')))==8
assert not list((root/'runs').glob('candidate-selected-*'))
assert (root/'spend-deepseek.jsonl').resolve()==root/'spend-reconciled.jsonl'
assert subprocess.check_output(['git','-C',str(root/sys.argv[1]),'rev-parse','HEAD']).decode().strip()==sys.argv[2]
reused=[json.loads(p.read_text()) for p in (root/'runs').glob('candidate-batch-subset-*/result.json')]
assert len(reused)==8 and all(r['repeat']==1 and r['agent_revision']==sys.argv[2] for r in reused)
with (root/'locks/deepseek.lock').open('a') as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('Selected source verified; all completed cohorts and complete ledger retained',flush=True)
PYCHECK
remote_base='docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-selected/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/SELECTED_CORE --pi-prefix /work/pi --agents light --models deepseek-flash,deepseek-v4-pro --workers 2 --spend-cap-usd 25 --balance-floor-usd 10'
remote_base="${remote_base/SELECTED_CORE/$chosen_tree}"
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
# New tasks: both repeats. Screening tasks: only missing repeat 2.
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" "$remote_base --phase candidate-selected-new --tasks 02-split-limit,03-window-padding,05-empty-refactor,07-source-manifest,08-integer-encoding,09-separator-payload,10-expiry-boundary,11-compression-marker --repeats 2 --repeat-start 1"
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" "$remote_base --phase candidate-selected-repeat2 --tasks 01-chunked-strict,04-count-by,06-key-rotation-map,12-partition-map --repeats 1 --repeat-start 2"
