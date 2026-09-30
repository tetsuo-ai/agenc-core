import json,pathlib,urllib.request,urllib.error,time,os
R=pathlib.Path('/home/paul/claude-agenc-work/light-models')
gate=json.loads((R/'evidence/luna-gate.json').read_text())
if not gate['ready'] or time.time()-gate['time']>30:raise SystemExit('Luna gate is not ready/current')
body={'model':'gpt-6-sol','input':[{'type':'message','role':'user','content':[{'type':'input_text','text':'Reply with OK.'}]}],'reasoning':{'effort':'low'},'max_output_tokens':16,'stream':True,'store':False}
row={'run':'sol-availability','call':1,'time':time.time()}
with (R/'openai-admissions.jsonl').open('a') as f:f.write(json.dumps(row)+'\n');f.flush();os.fsync(f.fileno())
out={'requested_model':'gpt-6-sol','reasoning':'low','ok':False};usage={};error=None
try:
 req=urllib.request.Request('http://127.0.0.1:8817/v1/responses',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=190) as res:
  for line in res:
   if not line.startswith(b'data: '):continue
   try:e=json.loads(line[6:])
   except ValueError:continue
   if e.get('type')=='response.completed':
    response=e.get('response',{});usage=response.get('usage',{});out.update(ok=str(response.get('model','')).startswith('gpt-6-sol'),returned_model=response.get('model'),usage=usage)
   if e.get('type') in ('error','response.failed','response.incomplete'):error={'type':e.get('type')};out['error']=error
except urllib.error.HTTPError as e:error={'status':e.code};out['error']=error
except Exception as e:error={'type':type(e).__name__};out['error']=error
record={**row,'model':'gpt-6-sol','usage':usage,'usage_missing':not bool(usage),'cost_usd':None,'budget_charge_usd':0,'seconds':time.time()-row['time'],'error':error}
with (R/'spend-openai.jsonl').open('a') as f:f.write(json.dumps(record)+'\n');f.flush();os.fsync(f.fileno())
(R/'evidence/sol-generation-preflight.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
