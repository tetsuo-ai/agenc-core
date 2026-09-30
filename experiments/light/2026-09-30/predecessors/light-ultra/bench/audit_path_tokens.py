"""Extract only flagged path-shaped tokens from owned benchmark requests for review."""
import argparse,collections,hashlib,json,re,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('audit',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
sys.path.insert(0,str(a.root/'packaged-next'));import trace_audit
rows=[];counts=collections.Counter()
for run in json.loads(a.audit.read_text())['runs']:
 for f in run['findings']:
  d=a.root/'runs'/run['run'];wire=d/f['wire']
  cs=trace_audit.response_calls(wire)[0] if wire.name.startswith('response-') else trace_audit.calls(json.loads(wire.read_text())['body'])
  for cid,name,args in cs:
   try:v=json.loads(args) if isinstance(args,str) else args
   except ValueError:v=args
   if hashlib.sha256(json.dumps([cid,name,v],sort_keys=True).encode()).hexdigest()!=f['call_sha256']:continue
   paths=[]
   for text in trace_audit.texts(v):
    for raw in re.findall(r'(?<![A-Za-z0-9])/(?:[^\s"\'`<>|;&]+)',text):
     path=Path(raw.rstrip('),]}')).resolve()
     if path.is_relative_to(d/'repo'):continue
     if str(path).startswith(('/usr/bin/','/bin/')) or str(path) in ('/dev/null','/dev/stdout','/dev/stderr'):continue
     paths.append(raw)
    if '../' in text:paths+=re.findall(r'.{0,30}\.\./.{0,60}',text)
   counts.update(paths);rows.append({'run':run['run'],'tool':name,'call_sha256':f['call_sha256'],'reasons':f['review_reasons'],'path_tokens':paths})
r={'phase':json.loads(a.audit.read_text()).get('phase'),'path_counts':dict(counts),'rows':rows};a.out.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(dict(counts),indent=2))
