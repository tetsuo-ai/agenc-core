import pathlib,json,tempfile,shutil,hashlib
from trace_checks import planning_evidence,name
R=pathlib.Path('/home/paul/claude-agenc-work/light-models')
source=R/'derived/g1-12-light-main'
assert planning_evidence(source,'light')['pass']
controls=[]
for variant in ('remove_success','break_identity','preload_planning'):
 with tempfile.TemporaryDirectory(dir=R/'derived') as tmp:
  d=pathlib.Path(tmp)
  for p in source.glob('wire-*.json'):
   x=json.loads(p.read_text());b=x['body']
   for item in b.get('input',[]):
    if item.get('type')=='function_call' and name(item.get('name',''))=='todowrite' and variant=='break_identity':item['call_id']='deliberately-unmatched-test-call'
    if item.get('type')=='function_call_output' and variant=='remove_success':item['output']=str(item.get('output','')).replace('Todos have been modified successfully','CONTROL: no success receipt')
   if variant=='preload_planning' and p.name=='wire-001.json':b.setdefault('tools',[]).append({'type':'function','name':'TodoWrite','parameters':{'type':'object'}})
   (d/p.name).write_text(json.dumps(x))
  assert not planning_evidence(d,'light')['pass'],variant
  controls.append(variant)
# Each insertion must name a response strictly earlier than its request.
audit=json.loads((source/'audit.json').read_text())
assert all(int(x['source_response'][9:12])<int(x['wire'][5:8]) for x in audit['insertions'])
assert (R/'harness/trace_checks.py').read_bytes()==(R/'frozen/trace_checks.py').read_bytes()
out={'positive':'pass','negative_controls':controls,'grader_unchanged':True,'provider_calls':0}
(R/'evidence/continuation-controls.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
