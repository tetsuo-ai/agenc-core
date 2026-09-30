import json,pathlib,sys
root=pathlib.Path(__file__).resolve().parent.parent
label=sys.argv[1];data=json.loads((root/f'evidence/decomposition-{label}.json').read_text());old=json.loads((root/'evidence/decomposition-converged.json').read_text())['runs'];bs={(r['model'],r['task'],r['repeat']):r for r in old if r['agent']=='pi' and r['phase'] in ['baseline','candidate-api-b','candidate-api-p']}
f=lambda v:'NA' if v is None else f'{v:,.1f}'
lines=[f'## {label} measured decomposition','',data['method'],'','| Phase / model/task | N/P/H* | Largest result @ request | Visible/reasoning | TTFT/generation s | Tool/overhead estimate s | ΔNP/ΔH*/Δoutput | Δtool+runtime s |','| --- | --- | --- | --- | --- | --- | --- | --- |']
for r in data['runs']:
 b=bs.get((r['model'],r['task'],r['repeat']));delta=lambda k:r[k]-b[k] if b and r.get(k) is not None and b.get(k) is not None else None
 largest=r['largest_results'][0] if r['largest_results'] else {}
 lines.append(f"| {r['phase']} / {r['model']}/{r['task'][:2]} | {r['N']}/{f(r['P_raw'])}/{f(r['history_residual'])} | {largest.get('raw_tokens','NA')}@{largest.get('first_input_call','NA')} | {f(r['visible_output'])}/{f(r['reasoning'])} | {f(r['ttft_s'])}/{f(r['generation_s'])} | {f(r.get('tool_interval_estimate_s'))}/{f(r.get('overhead_estimate_s'))} | {f(delta('NP_raw'))}/{f(delta('history_residual'))}/{f(delta('output'))} | {f(delta('tool_plus_overhead_s'))} |")
(root/f'evidence/{label}-decomposition.md').write_text('\n'.join(lines)+'\n')
