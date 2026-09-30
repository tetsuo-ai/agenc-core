import pathlib,json,hashlib
r=pathlib.Path.home()/'claude-agenc-work/light-ultra'
comparison=json.loads((r/'analysis/expanded-comparison.json').read_text())
decomp={x['id']:x for x in json.loads((r/'analysis/decomposition-expanded.json').read_text())['runs']}
rows=[]
for rid in comparison['run_ids']:
 p=r/'runs'/rid/'wire-001.json'
 if not p.exists():continue
 b=json.loads(p.read_text())['body'];v=decomp.get(rid,{})
 msgs=b.get('messages',b.get('input',[]))
 system='\n\n'.join(([b['instructions']] if b.get('instructions') else [])+[m.get('content','') if isinstance(m.get('content',''),str) else json.dumps(m.get('content',''),ensure_ascii=False,separators=(',',':')) for m in msgs if m.get('role') in ('system','developer')])
 schemas=json.dumps(b.get('tools',[]),ensure_ascii=False,separators=(',',':'))
 result=json.loads((p.parent/'result.json').read_text());usage=json.loads((p.parent/'usage-001.json').read_text()) if (p.parent/'usage-001.json').exists() else {}
 rows.append({'id':rid,'model':result['model'],'agent':result['agent'],'task':result['task'],'repeat':result['repeat'],'system_bytes':len(system.encode()),'schema_bytes':len(schemas.encode()),'system_raw_tokens':v.get('P_system_raw'),'schema_raw_tokens':v.get('P_schema_raw'),'tokenizer':v.get('prefix_tokenizer'),'first_input_tokens':usage.get('input_tokens'),'system_sha256':hashlib.sha256(system.encode()).hexdigest(),'schema_sha256':hashlib.sha256(schemas.encode()).hexdigest(),'tools':[t.get('name',t.get('function',{}).get('name')) for t in b.get('tools',[])]})
(r/'analysis/expanded-first-heads.json').write_text(json.dumps({'method':'Exact UTF8 system text and compact JSON schema bytes; raw tokenization excludes provider formatting and uses a labeled reference estimate on Luna. Provider first input includes the task and history.','runs':rows},indent=2)+'\n')
print('captured_heads',len(rows))
