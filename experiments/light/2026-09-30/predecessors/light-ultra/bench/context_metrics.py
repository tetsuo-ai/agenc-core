"""Offline request-shape measurements. Prints counts and hashes, never text."""
import argparse
import collections
import hashlib
import json
from pathlib import Path

p=argparse.ArgumentParser()
p.add_argument('root',type=Path)
p.add_argument('--phase',required=True)
a=p.parse_args()
rows=[]
def stable(v):return json.dumps(v,sort_keys=True,separators=(',',':'))
for d in sorted((a.root/'runs').glob(a.phase+'-*')):
 if not (d/'result.json').is_file():continue
 r=json.loads((d/'result.json').read_text())
 if r.get('phase')!=a.phase:continue
 systems=set();previous=[];mutations=[];tools=collections.Counter();sizes=[];seen=set()
 for wire in sorted(d.glob('wire-*.json')):
  b=json.loads(wire.read_text())['body'];messages=b.get('messages',b.get('input',[]))
  system=[m for m in messages if m.get('role') in ('system','developer')]
  systems.add(hashlib.sha256(stable(system).encode()).hexdigest())
  overlap=min(len(previous),len(messages))
  changed=[i for i in range(overlap) if stable(previous[i])!=stable(messages[i])]
  if changed:mutations.append({'request':wire.name,'positions':changed,'roles':[messages[i].get('role',messages[i].get('type')) for i in changed]})
  for i,m in enumerate(messages):
   if m.get('role')=='tool' or m.get('type')=='function_call_output':
    key=(m.get('tool_call_id',m.get('call_id')),stable(m))
    if key in seen:continue
    seen.add(key);size=len(stable(m.get('content',m.get('output',''))))
    sizes.append(size);tools[m.get('name','unnamed')]+=size
  previous=messages
 rows.append({'run':d.name,'model':r.get('model'),'agent':r.get('agent'),
 'distinct_system_prefixes':len(systems),'historical_mutation_requests':len(mutations),
 'mutation_positions':mutations,'distinct_tool_results':len(sizes),
 'tool_result_chars':sum(sizes),'max_tool_result_chars':max(sizes,default=0),'tool_chars_by_name':dict(tools)})
print(json.dumps({'phase':a.phase,'runs':rows},indent=2))
