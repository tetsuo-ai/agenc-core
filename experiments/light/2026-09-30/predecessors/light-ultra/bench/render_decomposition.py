import json,collections,statistics
from pathlib import Path
root=Path('/private/tmp/light-ultra');d=json.loads((root/'evidence/decomposition.json').read_text());rows=d['runs']
def f(v):return 'NA' if v is None else f'{v:,.0f}'
def mean(rs,k):return statistics.mean(r[k] for r in rs) if rs and all(r.get(k) is not None for r in rs) else None
def delta(r,bs,k):
 b=mean(bs,k)
 return r[k]-b if r.get(k) is not None and b is not None else None
lines=['<!-- decomposition-start -->','## Per-run analytic decomposition','',d['method'],'','Visible output includes assistant text and generated tool arguments. Provider-reported reasoning is separate. `R@i` is the largest raw non-system message at the first request that includes it; the role is shown. This includes assistant reasoning and arguments. Separate largest-tool rankings remain in JSON. `M` is total proxy request seconds. `X` is wall minus M: tool execution plus runtime startup/persistence/other overhead. Tool-only and overhead-only are NA for historical Pi; no fabricated split. X is diagnostic: timeout draining and timing boundaries can produce a small negative residual, which is not negative physical overhead. `Q/G` gives summed TTFT/generation when captured. All rows, including failures, are retained. Each delta compares with the available retained Pi repeats for the same task/model; partial Luna pairs remain provisional until both repeats finish. Luna P is a reference estimate, with encrypted bytes excluded from raw tokenization. Negative is less than Pi.','', '| Cohort / model / task / repeat | Done | N | P | ΣH* | R@i | Tool result @i | O visible / reason | Q / G s | M / X s | Tool / overhead est s | ΔNP | ΔH* | Δvisible / reason | ΔM / X s | Δtool / overhead s |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | ---: | ---: | --- | --- | --- |']
for r in rows:
 if r['agent'] not in ('pi','light','normal'):continue
 bs=[b for b in rows if (b['phase']=='baseline' or b['model']=='gpt-6-luna') and b['agent']=='pi' and b['task']==r['task'] and b['model']==r['model']]
 ranked=r.get('largest_messages',r['largest_results']);biggest=ranked[0] if ranked else None
 tool_big=r['largest_results'][0] if r['largest_results'] else None
 label=r['phase'].removeprefix('candidate-')+'/'+r['agent']+'/'+r['model'].replace('deepseek-v4-pro','pro').replace('deepseek-flash','flash')+'/'+r['task'].split('-')[0]+'/'+str(r['repeat'])
 lines.append(f"| {label} | {int(r['effective'])} | {r['N']} | {f(r['P_raw'])} | {f(r['history_residual'])} | {biggest.get('role','tool')+':'+str(biggest['raw_tokens'])+'@'+str(biggest['first_input_call']) if biggest else '-'} | {str(tool_big['raw_tokens'])+'@'+str(tool_big['first_input_call']) if tool_big else '-'} | {f(r['visible_output'])} / {f(r['reasoning'])} | {f(r['ttft_s'])} / {f(r['generation_s'])} | {f(r['model_s'])} / {f(r['tool_plus_overhead_s'])} | {f(r.get('tool_interval_estimate_s'))} / {f(r.get('overhead_estimate_s'))} | {f(delta(r,bs,'NP_raw'))} | {f(delta(r,bs,'history_residual'))} | {f(delta(r,bs,'visible_output'))} / {f(delta(r,bs,'reasoning'))} | {f(delta(r,bs,'model_s'))} / {f(delta(r,bs,'tool_plus_overhead_s'))} | {f(delta(r,bs,'tool_interval_estimate_s'))} / {f(delta(r,bs,'overhead_estimate_s'))} |")
lines+=['','Exact largest-three message and result sizes, positions, reasoning/history-field replay, schema growth, costs and per-run timing fields are in `evidence/decomposition.json`.','<!-- decomposition-end -->']
s=(root/'STATUS.md').read_text();start=s.find('<!-- decomposition-start -->');end=s.find('<!-- decomposition-end -->')
if start>=0:s=s[:start]+'\n'.join(lines)+s[end+len('<!-- decomposition-end -->'):]
else:s+='\n\n'+'\n'.join(lines)+'\n'
(root/'STATUS.md').write_text(s)
print('Recorded',len(rows),'run decompositions')
