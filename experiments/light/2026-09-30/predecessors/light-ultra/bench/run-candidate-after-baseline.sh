#!/bin/bash
set -euo pipefail
cd /private/tmp/light-ultra
SSH=(ssh -o ConnectTimeout=15 -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218)
# This PID was inspected on resume and belongs to this study's frozen baseline.
# Wait without holding any provider credential or occupying a benchmark slot.
while true; do
  probe=0
  "${SSH[@]}" 'test -r /proc/2942081/cmdline && tr "\0" " " < /proc/2942081/cmdline | grep -q "python3 /work/bench/start.py --phase baseline"' || probe=$?
  if [ "$probe" = 1 ]; then break; fi
  # A transport failure is not evidence that the baseline exited.
  sleep 20
done
"${SSH[@]}" 'docker run --rm --init --user "$(id -u):$(id -g)" --cpus=1 --memory=1g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-harness/reconcile_budget.py --root /work --source /work/spend.jsonl --out /work/spend-reconciled.jsonl --report /work/budget-reconciliation.json'
"${SSH[@]}" 'python3 - <<'"'"'PY'"'"'
import pathlib
root=pathlib.Path.home()/"claude-agenc-work/light-ultra"
ledger=root/"spend-deepseek.jsonl"
if ledger.exists() or ledger.is_symlink():
    if not ledger.is_symlink() or ledger.resolve() != (root/"spend-reconciled.jsonl").resolve():
        raise SystemExit("Refusing a separate study budget ledger")
else:
    ledger.symlink_to("spend-reconciled.jsonl")
print("Candidate uses the complete study ledger with audited request-time reserve bounds")
PY'
# The key enters only this command and SSH stdin, never arguments or files.
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" \
  'docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/bench/resume_baseline_entry.py --phase baseline --agents pi,normal,light --models deepseek-flash,deepseek-v4-pro --repeats 2 --workers 2'
printf '%s\n' "$DEEPSEEK_API_KEY" | "${SSH[@]}" \
  'docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-ultra:/work" -w /work node:26.5.0-bookworm python3 /work/packaged-harness/stdin_entry.py --root /work --core-base /work/core-base --core-candidate /work/core-candidate --pi-prefix /work/pi --phase candidate-final --agents light --models deepseek-flash,deepseek-v4-pro --repeats 2 --workers 2'
