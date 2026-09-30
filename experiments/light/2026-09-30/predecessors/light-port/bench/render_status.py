import argparse, json, math, statistics
from pathlib import Path
root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--input',type=Path,default=root/'evidence/decomposition.json')
args=parser.parse_args()
x=json.loads(args.input.read_text())
def f(v):
    return 'NA' if v is None else f'{v:,.1f}'
lines=['<!-- decomposition-start -->','## Measured decomposition','',x['notes'],'',
       'All retained Pi repeats are reused. Main-job candidates below are read-only behavioral evidence. F=Flash; P=Pro. Time columns are summed seconds per run, then averaged across repeats. Tool/overhead is only separable when tool completion events survived. Prefix drift is reported separately rather than called fixed history.','']
lines += ['### Own rounds against matched Pi tasks', '',
          'Pi retains both original repeats for each task represented in a round. Own screening uses one repeat. Incomplete rounds and the invalid catalog attempt are not selection evidence. Cells show own / Pi; pass columns show successes over attempts.', '',
          '| Round | Model | own pass | Pi pass | Median s | p90 s | Tokens/task | Calls/task | Reasoning/task |',
          '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for row in x['summary']:
    if not row['cohort'].startswith('port/'):continue
    tasks={r['task'] for r in x['runs'] if r['cohort']==row['cohort'] and r['model']==row['model']}
    pi=[r for r in x['runs'] if r['cohort']=='baseline-pi' and r['model']==row['model'] and r['task'] in tasks]
    if not pi:continue
    walls=sorted(r['wall'] for r in pi)
    values={'median':statistics.median(walls),'p90':walls[math.ceil(.9*len(walls))-1]}
    values.update({k:statistics.mean(r[k] for r in pi) if all(r[k] is not None for r in pi) else None for k in ['tokens','N','reasoning']})
    name=row['cohort'].removeprefix('port/')
    if name=='candidate-catalog-subset':name+=' (INVALID)'
    lines.append(f"| {name} | {'F' if row['model']=='deepseek-flash' else 'P'} | {row['passed']}/{row['runs']} | {sum(r['pass_'] for r in pi)}/{len(pi)} | " + ' | '.join(f"{f(row[k])} / {f(values[k])}" for k in ['median','p90','tokens','N','reasoning'])+' |')
lines += ['']
for model in ['deepseek-flash','deepseek-v4-pro']:
    lines += [f'### {model}', '', '| Cohort / task | pass | N | P | N×P | schema Δ | ΣH | largest r @ request/message | visible / reasoning O | request / wall s | TTFT / generation s | tools / overhead s | guard / runtime overhead s | unsplit tools+overhead s |',
              '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |']
    for r in x['tasks']:
        if r['model']!=model:continue
        top='; '.join(f"{v['tokens']:,}@{v['first_request']}/{v['message_position']}/r{v['run'].rsplit('-r',1)[-1]}" for v in r['largest_results'])
        lines.append(f"| {r['cohort']} / {r['task'][:2]} | {r['passed']}/{r['runs']} | {f(r['N'])} | {f(r['P'])} | {f(r['NP'])} | {f(r['schema_delta'])} | {f(r['H'])} | {top} | {f(r['visible'])} / {f(r['reasoning'])} | {f(r['request_seconds'])} / {f(r['wall'])} | {f(r['ttft'])} / {f(r['generation'])} | {f(r['tools'])} / {f(r['overhead'])} | {f(r.get('guard'))} / {f(r.get('runtime_overhead'))} | {f(r['tools_overhead'])} |")
    lines += ['', '| Cohort / task | largest message: role, tokens @ request/message (reasoning tokens) | raw reasoning replay |',
              '| --- | --- | ---: |']
    for r in x['tasks']:
        if r['model']!=model:continue
        top='; '.join(f"{v['role']} {v['tokens']:,}@{v['first_request']}/{v['message_position']}/r{v['run'].rsplit('-r',1)[-1]} (R {v['reasoning_tokens']:,})" for v in r['largest_messages'])
        lines.append(f"| {r['cohort']} / {r['task'][:2]} | {top} | {f(r['reasoning_replay_raw'])} |")
    lines += ['', '| Cohort / task | ΔN×P | Δschema | Δhistory | Δvisible O | Δreasoning O | Δrequest s | Δtool s | Δoverhead s | Δtools+overhead s | largest absolute / positive token term |',
              '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |']
    for r in x['tasks']:
        if r['model']!=model or r['cohort']=='baseline-pi':continue
        d=r['delta_pi'];term='no model call' if r['N']==0 else max(['NP','schema_delta','H','visible','reasoning'],key=lambda k:abs(d[k] or 0))
        lines.append(f"| {r['cohort']} / {r['task'][:2]} | " + ' | '.join(f(d[k]) for k in ['NP','schema_delta','H','visible','reasoning','request_seconds','tools','overhead','tools_overhead'])+f" | {term} / {max((k for k in ['NP','schema_delta','H','visible','reasoning'] if (d[k] or 0)>0),key=lambda k:d[k],default='none')} |")
lines += ['', '<!-- decomposition-end -->']
p=root/'STATUS.md';s=p.read_text();start=s.find('<!-- decomposition-start -->')
if start>=0:s=s[:start]+s[s.index('<!-- decomposition-end -->',start)+len('<!-- decomposition-end -->'):]
p.write_text(s.rstrip()+'\n\n'+'\n'.join(lines)+'\n')
