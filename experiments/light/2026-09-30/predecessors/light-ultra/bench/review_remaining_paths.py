"""Print only path-shaped tokens from newly flagged baseline calls for review."""
import collections,hashlib,json,pathlib,re,sys
root=pathlib.Path('/work');sys.path.insert(0,str(root/'packaged-next'))
import trace_audit
old={r['run'] for r in json.loads((root/'trace-review/baseline-v2.json').read_text())['runs']}
tokens=collections.Counter()
for run in json.loads((root/'trace-review/baseline-final.json').read_text())['runs']:
 if run['run'] in old:continue
 for f in run['findings']:
  d=root/'runs'/run['run'];p=d/f['wire']
  cs=trace_audit.response_calls(p)[0] if p.name.startswith('response-') else trace_audit.calls(json.loads(p.read_text())['body'])
  for call_id,name,args in cs:
   try:v=json.loads(args) if isinstance(args,str) else args
   except ValueError:v=args
   if hashlib.sha256(json.dumps([call_id,name,v],sort_keys=True).encode()).hexdigest()!=f['call_sha256']:continue
   for s in trace_audit.texts(v):
    for raw in re.findall(r'(?<![A-Za-z0-9])/(?:[^\s"\'`<>|;&]+)',s):
     path=pathlib.Path(raw.rstrip('),]}')).resolve()
     if path.is_relative_to(d/'repo'):continue
     tokens[raw]+=1
print(json.dumps(dict(sorted(tokens.items())),indent=2))
