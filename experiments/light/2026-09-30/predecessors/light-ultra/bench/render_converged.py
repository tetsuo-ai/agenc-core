import json
from pathlib import Path

root=Path(__file__).resolve().parent.parent
data=json.loads((root/'evidence/decomposition-converged.json').read_text())
rows=data['runs'] + json.loads((root/'evidence/decomposition-port-equal.json').read_text())['runs']
def fmt(value):return 'NA' if value is None else f'{value:,.1f}'
def delta(row,base,key):return None if base is None or row.get(key) is None or base.get(key) is None else row[key]-base[key]
lines=['<!-- converged-evidence-start -->','## Converged evidence','',
       'Each screen uses tasks 03/07/09/12, one repeat. Paired estimates match task and repeat; historical Pi and port cells are reused. Four-task bootstrap intervals are a rejection screen, not proof across tasks. Luna API screen c2 fails completion on tasks 03 and 12; no full confirmation or promotion is justified.', '',
       (root/'evidence/convergence-screen.md').read_text(),
       (root/'evidence/convergence-paired.md').read_text(),
       '### Per-task decomposition', '',data['method'],'',
       'Q/G are summed time to first token/generation seconds. X is tool plus runtime seconds. Tool and overhead splits are estimates from effect timestamps, unavailable for historical Pi. Deltas use Pi for the same model/task/repeat. No missing measurement is zero-filled.', '',
       '| Cohort/model/task/repeat | Done | N | P | H* | Largest tool result tokens @ call | Visible/reasoning | Q/G s | Model/X s | Tool/overhead est s | ΔNP/ΔH* | Δvisible/Δreasoning | Δmodel/ΔX s |',
       '| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- |']
for r in rows:
 if r['phase'] not in ('candidate-c1','candidate-c2','candidate-c3','candidate-api-p','candidate-api-b','candidate-api-c','candidate-eq'):continue
 if r['phase']=='candidate-eq' and r['task'][:2] not in {'03','07','09','12'}:continue
 base=next((b for b in rows if b['agent']=='pi' and b['model']==r['model'] and b['task']==r['task'] and b['repeat']==r['repeat'] and b['phase'] in (('candidate-api-p','candidate-api-b') if r['model']=='gpt-6-luna' else ('baseline',))),None)
 largest=r['largest_results'][0] if r['largest_results'] else None
 label='/'.join([r['phase'],r['model'],r['agent'],r['task'][:2],str(r['repeat'])])
 pairs=[('visible_output','reasoning'),('ttft_s','generation_s'),('model_s','tool_plus_overhead_s'),('tool_interval_estimate_s','overhead_estimate_s')]
 values=[' / '.join(fmt(r.get(k)) for k in pair) for pair in pairs]
 values += [' / '.join(fmt(delta(r,base,k)) for k in pair) for pair in [('NP_raw','history_residual'),('visible_output','reasoning'),('model_s','tool_plus_overhead_s')]]
 lines.append(f'| {label} | {int(r["effective"])} | {r["N"]} | {r["P_raw"]} | {fmt(r["history_residual"])} | '+ (f'{largest["raw_tokens"]}@{largest["first_input_call"]}' if largest else 'NA')+' | '+' | '.join(values)+' |')
lines += ['', '### Provider cache and history observations', '', (root/'evidence/cache-wire.md').read_text(),
          'The older frame schema rewrites are confirmed; response-ID continuations are intentional transport deltas. No causal cache gain follows from aggregate shares across different run lengths. The screened compact candidate rewrites advanced core schemas, but those selections were absent in the screen. The follow-up fix preserves core schemas and appends advanced definitions in discovery result data; dedicated network and serializer probes are reported in the latest resume section.',
          '', '<!-- converged-evidence-end -->']
block='\n'.join(lines)+'\n'
(root/'evidence/converged-evidence.md').write_text(block)
for filename in ['STATUS.md','REPORT.md']:
 path=root/filename;s=path.read_text();start=s.find('<!-- converged-evidence-start -->');end=s.find('<!-- converged-evidence-end -->')
 if start>=0:s=s[:start]+block+s[end+len('<!-- converged-evidence-end -->'):]
 else:s+='\n\n'+block
 path.write_text(s)
print('Updated converged tables and decomposition.')
