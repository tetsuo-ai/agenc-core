import json,pathlib,sys,collections
root=pathlib.Path(sys.argv[1]);phases=set(sys.argv[2].split(','));rows=[]
for rp in sorted((root/'runs').glob('*/result.json')):
 r=json.loads(rp.read_text())
 if r['phase'] not in phases:continue
 prev=None;changes=[];efforts=[];seen=set();counts=collections.Counter();prefix=[]
 for i,w in enumerate(sorted(rp.parent.glob('wire-*.json')),1):
  b=json.loads(w.read_text())['body'];ms=b.get('messages',b.get('input',[]));tools=b.get('tools',[])
  system=[m for m in ms if m.get('role') in ('system','developer')];history=[m for m in ms if m.get('role') not in ('system','developer')]
  current=(b.get('instructions'),system,tools,history)
  if prev:
   if current[:2]!=prev[:2]:changes.append([i,'system'])
   if tools[:len(prev[2])]!=prev[2]:changes.append([i,'schema'])
   if history[:len(prev[3])]!=prev[3]:changes.append([i,'history'])
  prev=current;efforts.append(b.get('reasoning',b.get('reasoning_effort')))
  for m in ms:
   for c in ([m] if m.get('type')=='function_call' else m.get('tool_calls',[])):
    id=c.get('call_id',c.get('id'))
    if id not in seen:
     seen.add(id);counts[c.get('name',c.get('function',{}).get('name'))]+=1
 rows.append({'run':r['id'],'prefix_changes':changes,'efforts':efforts,'calls':dict(counts),'initial_prefix_chars':r.get('first_system_chars',0)+r.get('first_schema_chars',0)})
print(json.dumps(rows,indent=2))
