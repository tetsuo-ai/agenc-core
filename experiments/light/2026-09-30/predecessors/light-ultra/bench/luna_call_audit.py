import json,pathlib
root=pathlib.Path('/home/paul/claude-agenc-work/light-ultra/runs')
rows=[]
for phase,agent,tasks in [('candidate-api-c','light',['03','07','09','12']),('candidate-api-b','pi',['03','07','12']),('candidate-api-p','pi',['09'])]:
 for task in tasks:
  d=next(root.glob(f'{phase}-gpt-6-luna-{task}*-{agent}-r1'))
  seen=set(); calls=[]
  for i,p in enumerate(sorted(d.glob('wire-*.json')),1):
   body=json.loads(p.read_text())['body']
   for x in body.get('input',[]):
    if x.get('type')=='function_call' and x['call_id'] not in seen:
     seen.add(x['call_id']);calls.append({'model_call':i-1,'id':x['call_id'],'name':x['name'],'arguments':json.loads(x['arguments'])})
    elif x.get('type')=='function_call_output':
     for c in calls:
      if c['id']==x['call_id']: c['result']=x['output']
  rows.append({'run':d.name,'calls':calls,'check':(d/'check.log').read_text()})
print(json.dumps(rows,indent=2))
