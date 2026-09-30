import pathlib,json,statistics,math,collections,datetime
r=pathlib.Path.home()/'claude-agenc-work/light-ultra'
rows=[]
for p in (r/'runs').glob('*/result.json'):
 x=json.loads(p.read_text());x['attempted_model_calls']=max(x['model_calls'],len(list(p.parent.glob('wire-*.json'))));rows.append(x)
selected=[]
phases={'candidate-round2-new','candidate-round2-repeat2','candidate-round2-confirm-screen'}
for x in rows:
 if x['phase']=='baseline' and x['agent'] in ('pi','normal'):selected.append(x)
 elif x['phase'] in phases:
  assert x['agent_revision']=='11e51dcc132dac8f413b59cc745135592f90dfed'
  selected.append(x)
 elif x['phase'].startswith('candidate-luna-full') or (x['phase']=='candidate-luna' and x['agent']=='pi'):
  selected.append(x)
seen=set()
for x in selected:
 key=(x['model'],x['agent'],x['task'],x['repeat'])
 assert key not in seen,key
 seen.add(key)
def stats(xs):
 n=len(xs);times=sorted(x['wall_seconds'] for x in xs);complete=all(x.get('usage_complete') for x in xs)
 return {'n':n,'pass':sum(bool(x['pass'] and x['check_pass'] and x['exit_code']==0 and not x.get('timeout') and not x.get('budget_stop')) for x in xs),'tokens':statistics.mean(x['input_tokens']+x['output_tokens'] for x in xs) if complete else None,'median':statistics.median(times),'p90':times[math.ceil(n*.9)-1],'calls':statistics.mean(x['attempted_model_calls'] for x in xs),'cost':sum(x['cost_usd'] for x in xs) if complete and all(x.get('cost_usd') is not None for x in xs) else None,'observed_cost':sum(x.get('cost_usd') or 0 for x in xs)}
aggregates=[];tasks=[];gates=[]
for model in sorted({x['model'] for x in selected}):
 for agent in sorted({x['agent'] for x in selected if x['model']==model}):
  xs=[x for x in selected if (x['model'],x['agent'])==(model,agent)]
  aggregates.append({'model':model,'agent':agent,**stats(xs)})
  for task in sorted({x['task'] for x in xs}):tasks.append({'model':model,'agent':agent,'task':task,**stats([x for x in xs if x['task']==task])})
 pi=[x for x in selected if x['model']==model and x['agent']=='pi'];light=[x for x in selected if x['model']==model and x['agent']=='light']
 if pi and light:
  p,l=stats(pi),stats(light);complete=len(pi)==len(light)==24
  losses=[];token_losses=[]
  for task in sorted({x['task'] for x in pi}):
   ps=[x for x in pi if x['task']==task];ls=[x for x in light if x['task']==task]
   if len(ps)==len(ls)==2:
    a,b=stats(ps),stats(ls)
    if b['pass']<a['pass']:losses.append(task)
    if b['tokens'] is None or a['tokens'] is None or b['tokens']>a['tokens']:token_losses.append(task)
  gates.append({'model':model,'complete':complete,'task_completion_losses':losses,'task_token_losses':token_losses,'completion':complete and l['pass']>=p['pass'] and not losses,'median':complete and l['median']<p['median'],'p90':complete and l['p90']<p['p90'],'mean_tokens':complete and l['tokens'] is not None and p['tokens'] is not None and l['tokens']<p['tokens']})
charges=[json.loads(x) for x in (r/'spend-reconciled.jsonl').read_text().splitlines()]
ids=set()
for path in (r/'spend-luna.jsonl',r/'luna-admissions.jsonl'):
 if path.exists():
  for line in path.read_text().splitlines():
   x=json.loads(line);ids.add((x['run'],x['call']))
result={'snapshot':datetime.datetime.now(datetime.timezone.utc).isoformat(),'aggregates':aggregates,'tasks':tasks,'gates':gates,'deepseek_observed_usd':sum(x.get('cost_usd') or 0 for x in charges),'deepseek_charge_usd':sum(x.get('budget_charge_usd',x.get('cost_usd')) or 0 for x in charges),'luna_calls':len(ids),'run_ids':[x['id'] for x in selected]}
(r/'analysis/expanded-comparison.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ('tasks','run_ids')},indent=2))
