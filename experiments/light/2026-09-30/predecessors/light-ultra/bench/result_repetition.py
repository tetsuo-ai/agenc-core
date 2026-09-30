"""Read-only output repetition diagnostics; characters are not provider tokens."""
import argparse,collections,hashlib,json,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('--phase',required=True);a=p.parse_args()
marker='===== AGENC UNTRUSTED TOOL RESULT DATA ====='
rows=[]
for d in sorted((a.root/'runs').glob(a.phase+'-*')):
 if not (d/'result.json').is_file():continue
 r=json.loads((d/'result.json').read_text())
 if r.get('phase')!=a.phase:continue
 totals=collections.Counter()
 for wire in sorted(d.glob('wire-*.json')):
  b=json.loads(wire.read_text())['body'];names={};seen=set()
  for m in b.get('messages',[]):
   for call in m.get('tool_calls',[]):names[call['id']]=call['function']['name']
   if m.get('role')!='tool' or not isinstance(m.get('content'),str):continue
   name=names.get(m.get('tool_call_id'),'unknown');body=m['content'];totals['tool_message_chars']+=len(body)
   if body.count(marker)==2:
    inside=body.split(marker)[1].strip('\n');totals['framing_chars']+=len(body)-len(inside);body=inside
   if name in ('exec_command','write_stdin'):
    footer=re.search(r'\n\n\[exec [^\n]*\]$',body)
    if footer:
     totals['exec_footer_chars']+=len(footer.group());body=body[:footer.start()]
   key=(name,hashlib.sha256(body.encode()).hexdigest())
   if key in seen and len(body)>500:
    totals['repeated_large_payload_chars']+=len(body);totals['repeated_large_payload_occurrences']+=1
   seen.add(key)
 rows.append({'id':r['id'],'model':r['model'],'agent':r['agent'],**totals})
print(json.dumps({'phase':a.phase,'interpretation':'Cumulative characters across captured requests. Duplicate estimate ignores exec footers, requires exact same text and tool name, and keeps the first occurrence. This is an upper-bound opportunity diagnostic, not token savings or a proposed history rewrite.','runs':rows},indent=2))
