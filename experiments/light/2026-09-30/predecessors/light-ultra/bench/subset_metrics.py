"""Compare a declared single-repeat candidate subset with retained Pi runs."""
import argparse,collections,json,math,statistics
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('phase')
p.add_argument('--tasks',default='01-chunked-strict,04-count-by,06-key-rotation-map,12-partition-map')
a=p.parse_args();tasks=set(a.tasks.split(','));rows=[];first={}
for line in (a.root/'spend-reconciled.jsonl').read_text().splitlines():
 r=json.loads(line)
 if r.get('call')==1:first[r['run']]=r.get('input_tokens')
groups=collections.defaultdict(list)
for f in (a.root/'runs').glob('*/result.json'):
 r=json.loads(f.read_text())
 if r['task'] not in tasks:continue
 if not (r['phase']==a.phase or r['phase']=='baseline' and r['agent']=='pi'):continue
 if r['agent'] not in ('pi','light'):continue
 groups[(r['model'],r['agent'])].append(r)
def mean(rs,k):return statistics.mean(r[k] for r in rs)
for (model,agent),rs in sorted(groups.items()):
 times=sorted(r['wall_seconds'] for r in rs);complete=all(r.get('usage_complete') for r in rs)
 rows.append({'model':model,'agent':agent,'runs':len(rs),
 'effective_pass':sum(bool(r.get('pass') and r.get('check_pass') and r.get('exit_code')==0 and not r.get('timeout') and not r.get('budget_stop')) for r in rs),
 'artifact_pass':sum(r['check_pass'] for r in rs),'median_s':statistics.median(times),'p90_s':times[math.ceil(.9*len(times))-1],
 'mean_total_tokens':mean(rs,'input_tokens')+mean(rs,'output_tokens') if complete else None,
 'mean_calls':mean(rs,'model_calls'),'cost_usd':sum(r['cost_usd'] or 0 for r in rs) if complete else None,
 'first_input_tokens':{r['task']+'-r'+str(r['repeat']):first.get(r['id']) for r in sorted(rs,key=lambda r:r['id'])},
 'per_task':[{k:r.get(k) for k in ('id','task','repeat','pass','input_tokens','output_tokens','model_calls','wall_seconds','stop_reason')} for r in rs]})
print(json.dumps({'candidate_phase':a.phase,'tasks':sorted(tasks),'baseline_policy':'All retained Pi repeats for these tasks; candidate subset has one repeat. Not a full-suite acceptance result.','rows':rows},indent=2))
