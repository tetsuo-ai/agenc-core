"""Refresh the live summary without altering the retained implementation history."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
snapshot = json.loads((root / 'evidence/progress.json').read_text())
spend = snapshot['spend']
lines = ['<!-- live-start -->', '## Live measurements', '', f"Snapshot: {snapshot['updated_utc']}.", '']
for phase, group in snapshot['phases'].items():
    if phase == 'baseline' or phase.startswith(('candidate-final', 'candidate-lean', 'candidate-context', 'candidate-tight', 'candidate-minimal', 'candidate-bounded', 'candidate-batch', 'candidate-focus', 'candidate-selected')):
        lines.append(f"- {phase}: {group['runs']} recorded runs; {group['effective_pass']} successful completions; {group['artifact_pass']} passing artifacts; {group['incomplete_usage']} with incomplete usage.")
candidate_started = 'candidate-final' in snapshot['phases'] or any(name.startswith('candidate-final-') for name in snapshot['unreported'])
phase = 'Candidate comparison has started.' if candidate_started else 'Candidate comparison is queued after baseline completion.'
lines += [f"- DeepSeek recorded list-rate estimate: ${spend['provider_list_rate_usd']:.6f}. Conservative study charge: ${spend['conservative_charge_usd']:.6f}. Pending calls can add spend. Ledger: {spend.get('ledger', 'spend.jsonl')}.", '- Earlier230e8c101 full suite:31,285 passed/31 failed/11 skipped versus main31,236/27/11. Later4645b4be0:31,287/39/11, with fixed child-identity failures and durability timeouts under comparison. Selected9e7edc397 full suite finished31,296/30/11; two daemon timeouts pass focused main/current checks; the corrected four-tool polling assertion also passes. ' + phase, '', '<!-- live-end -->']
path = root / 'STATUS.md'
text = path.read_text()
start, end = '<!-- live-start -->', '<!-- live-end -->'
block = '\n'.join(lines)
if start in text:
    text = text[:text.index(start)] + block + text[text.index(end) + len(end):]
else:
    heading, rest = text.split('\n', 1)
    text = heading + '\n\n' + block + '\n' + rest
path.write_text(text)
