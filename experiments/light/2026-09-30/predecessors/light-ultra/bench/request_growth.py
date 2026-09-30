"""Compare captured request growth without emitting source, prompts or tool arguments."""
import argparse,collections,json,statistics
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('--phase',required=True);a=p.parse_args()
rows=[]
for d in sorted((a.root/'runs').glob(a.phase+'-*')):
 if not (d/'result.json').exists():continue
 r=json.loads((d/'result.json').read_text())
 if r['phase']!=a.phase:continue
 ws=sorted(d.glob('wire-*.json'));c=collections.Counter();roles=collections.Counter();names={};seen=set();errors=collections.Counter();calls=collections.Counter()
 for w in ws:
  b=json.loads(w.read_text())['body']
  for m in b.get('messages',[]):
   for tc in m.get('tool_calls',[]):names[tc['id']]=tc['function']['name']
   for k,v in m.items():
    if k not in ('role','name'):c[m.get('role','unknown')+'.'+k]+=len(json.dumps(v,ensure_ascii=False))
   if m.get('role')=='tool':
    key=m.get('tool_call_id');name=names.get(key,'unknown')
    if key in seen:continue
    seen.add(key);calls[name]+=1
    body=m.get('content','')
    if body=='File has not been read yet. Read it first before writing to it.':errors['read_before_write']+=1
    elif isinstance(body,str) and body.startswith('File has been modified since read'):errors['stale_read']+=1
    elif isinstance(body,str) and 'No changes to make:' in body:errors['no_change']+=1
  if w==ws[-1]:roles.update(m.get('role','unknown') for m in b.get('messages',[]))
 rows.append({'id':r['id'],'model':r['model'],'agent':r['agent'],'requests':len(ws),'cumulative_chars_by_message_field':c,'final_request_roles':roles,'completed_tool_results_by_name':calls,'canonical_edit_errors':errors})
print(json.dumps({'phase':a.phase,'unit':'Characters across captured requests, not provider tokens. Error counts include only exact canonical edit errors.','runs':rows},indent=2))
