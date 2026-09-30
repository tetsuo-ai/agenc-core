#!/bin/bash
set -euo pipefail
cd /private/tmp/light-models
ssh -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218 'python3 ~/claude-agenc-work/light-models/harness/normalize_trace.py >/dev/null && python3 ~/claude-agenc-work/light-models/harness/metrics_pc.py && python3 ~/claude-agenc-work/light-models/harness/input_metrics_pc.py'
scp -q -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218:/home/paul/claude-agenc-work/light-models/evidence/metrics.json evidence/
scp -q -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes 'paul@192.168.1.218:/home/paul/claude-agenc-work/light-models/evidence/per-call-input.*' 'paul@192.168.1.218:/home/paul/claude-agenc-work/light-models/evidence/first-request.*' evidence/
python3 harness/report.py
python3 harness/report_finish.py
