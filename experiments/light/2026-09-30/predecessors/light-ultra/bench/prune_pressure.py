"""Pressure diagnostic using existing microcompaction eligibility, never mutates traces."""
from pathlib import Path
import json,collections
root=Path.home()/'claude-agenc-work'
out=[]
for job in ['light-ultra','light-models']:
 for d in (root/job/'runs').iterdir():
  p=d/'result.json'
  if not p.is_file():continue
  r=json.loads(p.read_text())
  if job=='light-ultra' and r['phase'] not in ['candidate-c2','candidate-api-c']:continue
  if job=='light-models' and r['agent']!='light-port':continue
  largest=0;share=0;triggers={str(x):0 for x in [.1,.25,.5,.75]}
  for p in sorted(d.glob('wire-*.json')):
   b=json.loads(p.read_text())['body']
   if b.get('previous_response_id'):continue
   messages=b.get('messages',b.get('input',[]));calls={};results=[];latest={}
   for m in messages:
    for c in m.get('tool_calls',[]):
     f=c.get('function',{});calls[c['id']]=f
    if m.get('type')=='function_call':calls[m['call_id']]={'name':m.get('name'),'arguments':m.get('arguments','{}')}
    if m.get('role')=='tool' or m.get('type')=='function_call_output':
     ident=m.get('tool_call_id',m.get('call_id'));f=calls.get(ident,{})
     if f.get('name') not in ['FileRead','Read','exec_command','system.bash','Bash','PowerShell','Grep','Glob','WebSearch','web_fetch','WebFetch','Edit','Write']:continue
     text=m.get('content',m.get('output',''));n=len(text) if isinstance(text,str) else len(json.dumps(text));path=None
     if f.get('name') in ['FileRead','Read']:
      try:path=json.loads(f.get('arguments','{}')).get('file_path')
      except:pass
     if path:latest[path]=ident
     if n>=6000:results.append((ident,n,path))
   eligible=sum(n for ident,n,path in results[:-5] if not path or latest.get(path)!=ident)
   history=len(json.dumps(messages));fraction=eligible/history if history else 0
   largest=max(largest,eligible);share=max(share,fraction)
   for t in triggers:triggers[t]+=fraction>float(t)
  out.append({'job':job,'id':r['id'],'model':r['model'],'max_prunable_chars':largest,'max_prunable_history_share':share,'requests_over_share':triggers})
print(json.dumps({'method':'Recorded full-history requests. Existing >=6000-char result eligibility, retain latest five eligible results and newest read per path. Response-ID deltas excluded. A pressure diagnostic, not counterfactual cache token savings or a live threshold benchmark.','runs':out},indent=2))
