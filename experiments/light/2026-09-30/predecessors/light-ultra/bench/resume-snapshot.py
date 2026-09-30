import json,pathlib,collections,statistics,math
r=pathlib.Path.home()/'claude-agenc-work/light-ultra'
allrows=[]
for p in (r/'runs').glob('*/result.json'):
 x=json.loads(p.read_text());x['model_calls']=max(x['model_calls'],len(list(p.parent.glob('wire-*.json'))));allrows.append(x)
for phase in sorted({x['phase'] for x in allrows if 'round2-' in x['phase'] or 'brief-' in x['phase'] or 'luna-' in x['phase'] or 'rel-subset' in x['phase']}):
 for model,agent in sorted({(x['model'],x['agent']) for x in allrows if x['phase']==phase}):
  xs=[x for x in allrows if (x['phase'],x['model'],x['agent'])==(phase,model,agent)];ws=sorted(x['wall_seconds'] for x in xs)
  print(json.dumps({'phase':phase,'model':model,'agent':agent,'n':len(xs),'pass':sum(x['pass'] for x in xs),'median':round(statistics.median(ws),2),'p90':round(ws[math.ceil(len(xs)*.9)-1],2),'tokens':round(statistics.mean(x['input_tokens']+x['output_tokens'] for x in xs)) if all(x.get('usage_complete') for x in xs) else None,'calls':round(statistics.mean(x['model_calls'] for x in xs),2)}))
ids=set()
for p in (r/'spend-luna.jsonl',r/'luna-admissions.jsonl'):
 if p.exists():
  for l in p.read_text().splitlines():
   x=json.loads(l);ids.add((x['run'],x['call']))
print('Luna calls charged',len(ids))
