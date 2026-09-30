#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
"${SSH[@]}" 'python3 - <<'"'"'PY'"'"'
import pathlib,json
root=pathlib.Path.home()/"claude-agenc-work/light-ultra"
assert not pathlib.Path("/proc/1031634").exists(), "Baseline still running"
assert (root/"spend-deepseek.jsonl").is_symlink()
assert (root/"spend-deepseek.jsonl").resolve()==root/"spend-reconciled.jsonl"
rows=[json.loads(p.read_text()) for p in (root/"runs").glob("baseline-*/result.json")]
assert len(rows)==144, "Baseline incomplete"
assert not list((root/"runs").glob("candidate-final-*")), "Candidate already started"
print("144 baseline results preserved; candidate appends to complete study ledger",flush=True)
PY'
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" \
  'docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-harness/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/core-candidate --pi-prefix /work/pi --phase candidate-final --agents light --models deepseek-flash,deepseek-v4-pro --repeats 2 --workers 2 --spend-cap-usd 20 --balance-floor-usd 10'
