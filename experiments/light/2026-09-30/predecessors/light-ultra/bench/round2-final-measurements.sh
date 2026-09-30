#!/bin/bash
# Linux-only, read-only analysis of completed measurements. No provider calls.
set -euo pipefail
task_root="$HOME/claude-agenc-work/light-ultra"
python3 - "$task_root" <<'PY'
import fcntl,json,pathlib,sys
r=pathlib.Path(sys.argv[1]);selected=[]
for phase,count in [('candidate-round2-confirm-screen',8),('candidate-round2-new',32),('candidate-round2-repeat2',8)]:
    paths=list((r/'runs').glob(phase+'-*/result.json'))
    assert len(paths)==count,(phase,len(paths))
    selected.extend(json.loads(p.read_text()) for p in paths)
assert len({(s['model'],s['task'],s['repeat']) for s in selected})==48
assert {s['agent_revision'] for s in selected}=={'11e51dcc132dac8f413b59cc745135592f90dfed'}
with (r/'locks/deepseek.lock').open('a') as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
print('All selected cells complete with one production revision; provider lock is free.',flush=True)
PY
python3 "$task_root/packaged-demand/summarize.py" --runs "$task_root/runs" \
  --manifest "$task_root/packaged-demand/tasks/manifest.json" \
  --candidate-phase candidate-round2-new --reuse-candidate-phase candidate-round2-repeat2 \
  --reuse-candidate-phase candidate-round2-confirm-screen --models deepseek-flash,deepseek-v4-pro \
  --json-out "$task_root/analysis/round2-comparison.json" \
  --markdown-out "$task_root/analysis/round2-comparison.md" > "$task_root/analysis/round2-summary-output.txt"
python3 "$task_root/bench/first_request_metrics.py" "$task_root" --phases candidate-round2-new,candidate-round2-repeat2,candidate-round2-confirm-screen > "$task_root/analysis/round2-first-requests.json"
python3 "$task_root/bench/progress.py" > "$task_root/analysis/final-progress.json"
python3 "$task_root/bench/iteration_metrics.py" "$task_root" > "$task_root/analysis/final-iterations.json"
python3 "$task_root/bench/analyze_gates.py" "$task_root/runs" --glob 'candidate-round2-*' > "$task_root/analysis/round2-new-gates.json"
for phase in candidate-round2-new candidate-round2-repeat2; do
  python3 "$task_root/bench/context_metrics.py" "$task_root" --phase "$phase" > "$task_root/analysis/$phase-context.json"
  python3 "$task_root/bench/request_growth.py" "$task_root" --phase "$phase" > "$task_root/analysis/$phase-growth.json"
done
docker run --rm --user "$(id -u):$(id -g)" --cpus=1 --memory=2g \
  -v "$task_root:/work" -w /work node:26.5.0-bookworm \
  python3 /work/packaged-audit-final/trace_audit.py --runs /work/runs --benchmark-root /work \
  --completed-only --out /work/trace-review/all-completed-round2.json
python3 "$task_root/packaged-audit-final/export_evidence.py" --runs "$task_root/runs" \
  --ledger "$task_root/spend-reconciled.jsonl" --ledger "$task_root/spend-luna.jsonl" \
  --phases baseline,candidate-round2-confirm-screen,candidate-round2-new,candidate-round2-repeat2 \
  --out "$task_root/public-evidence-round2-v1" > "$task_root/analysis/round2-export-counts.json"
printf 'Final analysis and allowlisted export complete.\n'
