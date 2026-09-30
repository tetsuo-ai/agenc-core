import sys,pathlib,json,hashlib,re
root=pathlib.Path('/work');sys.path.insert(0,str(root/'packaged-next'))
import trace_audit
old={r['run'] for r in json.loads((root/'trace-review/baseline-v2.json').read_text())['runs']}
new=json.loads((root/'trace-review/baseline-final.json').read_text())['runs']
for run in new:
 if run['run'] in old:continue
 for f in run['findings']:
  d=root/'runs'/run['run'];p=d/f['wire']
  cs=trace_audit.response_calls(p)[0] if p.name.startswith('response-') else trace_audit.calls(json.loads(p.read_text())['body'])
  for call_id,name,args in cs:
   try:canonical=json.loads(args) if isinstance(args,str) else args
   except ValueError:canonical=args
   digest=hashlib.sha256(json.dumps([call_id,name,canonical],sort_keys=True).encode()).hexdigest()
   if digest!=f['call_sha256']:continue
   text=json.dumps(canonical).replace(str(d/'repo'),'<repo>')
   # Only publish path-shaped snippets for review; no source or arbitrary output.
   snippets=re.findall(r'.{0,65}(?:\.\./|/tmp/|/work/|/usr/|/etc/|/home/|/root/).{0,100}',text)
   if snippets:print(json.dumps({'run':run['run'],'tool':name,'hash':digest,'snippets':snippets}))
