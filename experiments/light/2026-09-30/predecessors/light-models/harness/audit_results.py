import json,pathlib,collections,hashlib
R=pathlib.Path('/home/paul/claude-agenc-work/light-models');errors=[];counts=collections.Counter();request_ids=set();reported_models=collections.defaultdict(set);provider_intervals=collections.defaultdict(list)
for p in (R/'runs').glob('*/result.json'):
 x=json.loads(p.read_text());counts[x['model']]+=1
 if x['repeat'] != 1:errors.append('repeat range')
 if x['agent_revision'] not in ['0.73.1','11e51dcc132dac8f413b59cc745135592f90dfed','3c954ea5591c683aa9b14a0219345e11051b06dd']:errors.append('source revision')
 t=json.loads((R/'harness/tasks/manifest.json').read_text())['tasks'];task=next(t for t in t if t['id']==x['task'])
 if hashlib.sha256(task['prompt'].encode()).hexdigest()!=x['prompt_sha256']:errors.append('prompt mismatch')
 for w in p.parent.glob('wire-*.json'):
  d=json.loads(w.read_text());b=d['body']
  if b['model']!=x['model']:errors.append('wire model mismatch')
  if x['provider'] in ('grok','openai'):
   if b.get('reasoning',{}).get('effort')!='low' or b.get('max_output_tokens')!=8192:errors.append('reasoning or output mismatch')
  else:
   if b.get('thinking')!={'type':'adaptive'} or b.get('service_tier')!='standard' or b.get('max_tokens')!=8192:errors.append('MiniMax settings mismatch')
  if any(k.lower() in ('authorization','api-key','x-api-key') for k in d):errors.append('captured headers')
 for response in p.parent.glob('response-*.txt'):
  for line in response.read_text().splitlines():
   if not line.startswith('data: '):continue
   try:e=json.loads(line[6:])
   except ValueError:continue
   m=e.get('model',e.get('response',{}).get('model'))
   if m:reported_models[x['model']].add(m)
 for u in p.parent.glob('usage-*.json'):
  d=json.loads(u.read_text());i=(d['run'],d['call'])
  if i in request_ids:errors.append('duplicate call identity')
  request_ids.add(i);tm=d.get('timing',{});a=tm.get('upstream_start_at');b=tm.get('stream_end_at')
  if a and b:provider_intervals[x['provider']].append((a,b))
  if d['input_tokens']!=d['cached_tokens']+d['uncached_tokens']:errors.append('input accounting')
for provider,spans in provider_intervals.items():
 last=0
 for a,b in sorted(spans):
  if a<last-.002:errors.append(provider+' concurrent calls')
  last=max(last,b)
for provider,cap in [('grok',800),('openai',600)]:
 p=R/(provider+'-admissions.jsonl');n=len(p.read_text().splitlines()) if p.exists() else 0
 if n>cap:errors.append(provider+' exceeded cap')
d=json.loads((R/'evidence/metrics.json').read_text())
if d['ledgers']['minimax']['charged_usd']>6:errors.append('MiniMax exceeded spend cap')
expected={(m,a,t['id'],1) for m in ('grok-4.7','gpt-6-sol','MiniMax-M3') for a in ('pi','light-main','light-port') for t in json.loads((R/'harness/tasks/manifest.json').read_text())['tasks']}
actual={(x['model'],x['agent'],x['task'],x['repeat']) for x in d['runs']}
if actual!=expected or len(d['runs'])!=108:errors.append('incomplete or duplicate first-repeat matrix')
for x in d['runs']:
 if abs(x['model_seconds']+x['tool_plus_runtime_seconds']-x['wall_seconds'])>.01:errors.append('time split does not reconcile')
 us=[json.loads(p.read_text()) for p in (R/'runs'/x['id']).glob('usage-*.json')]
 if len(us)!=x['model_calls']:errors.append('call count does not reconcile')
 for k in ('input_tokens','cached_tokens','uncached_tokens','output_tokens'):
  if sum(u[k] for u in us)!=x[k]:errors.append(k+' does not reconcile')
for provider in ('grok','openai','minimax'):
 adm=[json.loads(l) for l in (R/(provider+'-admissions.jsonl')).read_text().splitlines()]
 spent=[json.loads(l) for l in (R/('spend-'+provider+'.jsonl')).read_text().splitlines()]
 ai=[(x['run'],x['call']) for x in adm];si=[(x['run'],x['call']) for x in spent]
 if len(ai)!=len(set(ai)) or len(si)!=len(set(si)) or set(ai)!=set(si):errors.append(provider+' admission reconciliation')
 if d['ledgers'][provider]['interrupted_or_pending']:errors.append(provider+' unresolved admission')
bridge=[json.loads(l) for l in (R/'evidence/grok-admissions.jsonl').read_text().splitlines()]
if sum(x['state']=='admitted' for x in bridge)!=d['ledgers']['grok']['admitted']:errors.append('Grok bridge admission mismatch')
report={'reported_models':{k:sorted(v) for k,v in reported_models.items()},'models':dict(counts),'errors':dict(collections.Counter(errors)),'unique_completed_call_ids':len(request_ids),'observed_max_provider_concurrency':1 if not any('concurrent' in e for e in errors) else 'violation','tasks_and_graders':'same frozen hash verified separately'}
(R/'evidence/final-audit.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
