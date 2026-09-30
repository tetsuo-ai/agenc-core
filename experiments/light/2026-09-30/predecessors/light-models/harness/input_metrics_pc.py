import pathlib,json,csv
R=pathlib.Path('/home/paul/claude-agenc-work/light-models')
rows=[];first=[]
for p in sorted((R/'runs').glob('*/result.json')):
 x=json.loads(p.read_text())
 if x['repeat']!=1:continue
 us=sorted([json.loads(u.read_text()) for u in p.parent.glob('usage-*.json')],key=lambda u:u['call'])
 for u in us:
  rows.append(dict(run=x['id'],model=x['model'],agent=x['agent'],task=x['task'],call=u['call'],input_tokens=u['input_tokens'],cached_tokens=u['cached_tokens'],uncached_tokens=u['uncached_tokens'],output_tokens=u['output_tokens'],usage_missing=u['usage_missing']))
 if us:
  w=json.loads(sorted(p.parent.glob('wire-*.json'))[0].read_text())['body']
  first.append(dict(run=x['id'],model=x['model'],agent=x['agent'],task=x['task'],input_tokens=us[0]['input_tokens'],cached_tokens=us[0]['cached_tokens'],system_chars=x['first_system_chars'],schema_chars=x['first_schema_chars'],body_json_utf8_bytes=len(json.dumps(w,separators=(',',':'),ensure_ascii=False).encode())))
for name,data in [('per-call-input',rows),('first-request',first)]:
 (R/'evidence'/f'{name}.json').write_text(json.dumps(data,indent=2)+'\n')
 with (R/'evidence'/f'{name}.csv').open('w') as f:
  wr=csv.DictWriter(f,fieldnames=list(data[0]));wr.writeheader();wr.writerows(data)
print(json.dumps({'calls':len(rows),'first_requests':len(first)}))
