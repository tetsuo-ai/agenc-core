import json
from pathlib import Path
root=Path(__file__).resolve().parent.parent
r=json.loads((root/'evidence/iterations.json').read_text())
f=lambda n,d=1:'unknown' if n is None else f'{n:,.{d}f}'
lines=['<!-- iteration-start -->','## Iteration measurements','',f"Snapshot: {r['snapshot']}. Completed results only; a partial cohort is not a balanced comparison. Failures remain included. Unknown tokens means usage is missing, not zero. For missing usage, cost shows the observed lower bound and conservative ledger charge. P90 is nearest rank. Calls and tokens are per-run means; cost is the cohort total. All pilots and Luna attempts remain in the study ledger.",'','| Cohort | Model | Agent | Effective / N | Artifact / N | Median / p90 s | Tokens/run | Calls/run | Cost USD |','| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |']
for v in r['rows']:
 lines.append(f"| {v['phase']} | {v['model']} | {v['agent']} | {v['effective']}/{v['runs']} | {v['artifact']}/{v['runs']} | {f(v['median'])} / {f(v['p90'])} | {f(v['mean_tokens'],0)} | {f(v['mean_calls'])} | {f(v['cost_usd'],6) if v['cost_usd'] is not None else ('unpriced' if v['model']=='gpt-6-luna' else '>='+f(v['observed_cost_usd'],6)+'; charged '+f(v['conservative_charge_usd'],6))} |")
lines+=['','Source mapping: candidate-final =230e8c101; candidate-lean-subset =c52ee4f7d (364 focused checks including test-only tip48afd25e8); candidate-context-subset =4fac1c7a2 (164 focused checks); candidate-tight-subset =540dc513d (bounds plus7ee89bc8f prompt/identity; test-only Core tip52dddae8b). candidate-minimal-subset =d62a5631e; candidate-bounded-subset =67fcf2285; candidate-batch-subset =9e7edc397; candidate-focus-subset =45c0f7b0d. Each cohort uses a separate frozen Linux build. No baseline or completed cell is rerun.','<!-- iteration-end -->']
p=root/'STATUS.md';s=p.read_text();start='<!-- iteration-start -->';end='<!-- iteration-end -->';block='\n'.join(lines)
if start in s:s=s[:s.index(start)]+block+s[s.index(end)+len(end):]
else:s+='\n\n'+block+'\n'
p.write_text(s)
