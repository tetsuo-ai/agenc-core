"""Read-only request-layout audit. Emits counts, never message or schema text."""
import argparse
import collections
import json
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('roots',nargs='+',type=Path);p.add_argument('--out',required=True,type=Path);a=p.parse_args()
def encoded(x):return json.dumps(x,ensure_ascii=False,separators=(',',':'))
rows=[]
for root in a.roots:
 for result in sorted((root/'runs').glob('*/result.json')):
  r=json.loads(result.read_text())
  if root.name=='light-ultra' and not (r['phase'].startswith(('candidate-c','candidate-api-')) or r['phase']=='baseline' and r['agent']=='pi'):continue
  if root.name=='light-port' and r['phase']!='candidate-eq':continue
  wires=sorted(result.parent.glob('wire-*.json'))
  previous=None;changes=[];growth=[];max_results=[];first=None;continuations=0
  for i,wire in enumerate(wires,1):
   b=json.loads(wire.read_text())['body']
   messages=b.get('messages',b.get('input',[]))
   if isinstance(messages,str):messages=[{'role':'user','content':messages}]
   system=[m for m in messages if m.get('role') in ('system','developer')]
   history=[m for m in messages if m.get('role') not in ('system','developer')]
   prefix=encoded([b.get('instructions'),system])
   tools=[encoded(t) for t in b.get('tools',[])]
   h=[encoded(m) for m in history]
   if first is None:first={'system_chars':len(prefix),'schema_chars':len(encoded(b.get('tools',[])))}
   continuation=bool(b.get('previous_response_id'))
   if continuation:continuations+=1
   if previous:
    ps,pt,ph=previous
    flags=[]
    if not continuation and prefix!=ps:flags.append('system_changed')
    if tools[:len(pt)]!=pt:flags.append('schema_prefix_changed')
    if not continuation and h[:len(ph)]!=ph:flags.append('history_prefix_changed')
    if flags:changes.append({'call':i,'changes':flags})
    growth.append(sum(map(len,h)) if continuation else sum(map(len,h))-sum(map(len,ph)))
   for position,m in enumerate(history):
    if m.get('role')=='tool' or m.get('type')=='function_call_output':
     max_results.append({'chars':len(encoded(m.get('content',m.get('output','')))),'call':i,'position':position})
   # A response-id continuation intentionally carries only new input. Its
   # remote retained history cannot be reconstructed from requests alone.
   previous=None if continuation else (prefix,tools,h)
  counts=collections.Counter(flag for change in changes for flag in change['changes'])
  rows.append({'job':root.name,'id':r['id'],'model':r['model'],'agent':r['agent'],'phase':r['phase'],'task':r['task'],'repeat':r['repeat'],'revision':r['agent_revision'],
    'calls':len(wires),'response_id_continuations':continuations,'first':first,'changes':changes,'change_counts':dict(counts),'history_growth_chars':growth,
    'largest_result':max(max_results,key=lambda x:x['chars']) if max_results else None,
    'raw_tokens':r['input_tokens']+r['output_tokens'] if r['usage_complete'] else None,
    'input_tokens':r['input_tokens'] if r['usage_complete'] else None,'cached_tokens':r['cached_tokens'] if r['usage_complete'] else None,
    'uncached_tokens':r['uncached_tokens'] if r['usage_complete'] else None})
a.out.write_text(json.dumps(rows,indent=2)+'\n')
print(json.dumps({'runs':len(rows),'layout_changes':dict(collections.Counter(flag for r in rows for c in r['changes'] for flag in c['changes']))}))
