import pathlib,json,collections,time
R=pathlib.Path('/home/paul/claude-agenc-work/light-models')
rows=[]
for d in sorted((R/'runs').glob('*')):
 if not (d/'result.json').exists():continue
 x=json.loads((d/'result.json').read_text())
 usages=[json.loads(p.read_text()) for p in sorted(d.glob('usage-*.json'))]
 x['tokens']=x.get('input_tokens',0)+x.get('output_tokens',0)
 x['failure_category']=None;x['failure_cause']=None
 if not x['pass']:
  if x.get('provider_errors'):
   x['failure_category']='provider error';x['failure_cause']='; '.join(sorted(set(json.dumps(y['error'],sort_keys=True) for y in usages if y.get('error'))))
  elif x.get('stop_reason') in ('settings_mismatch','study_call_cap','spend_cap','call_limit','provider_subset_stop'):
   x['failure_category']='agent' if x['stop_reason']=='call_limit' else 'benchmark setup';x['failure_cause']='45-call limit'+(' and 300-second deadline' if x.get('timeout') else '') if x['stop_reason']=='call_limit' else x['stop_reason']
  elif not x.get('model_calls'):
   x['failure_category']='benchmark setup';x['failure_cause']='agent startup failed before model call'
  else:
   x['failure_category']='agent';x['failure_cause']='300-second deadline' if x['timeout'] else 'artifact grader failed' if not x['check_pass'] else 'required deferred planning action missing' if not x.get('deferred_evidence',{}).get('pass',True) else 'nonzero agent exit'
 x['provider_error_details']=[y['error'] for y in usages if y.get('error')]
 if not x['check_pass'] and (d/'check.log').exists():
  lines=(d/'check.log').read_text().splitlines()
  detail=next((l.strip() for l in reversed(lines) if l.startswith(('AssertionError:','AttributeError:','TypeError:','ValueError:'))), 'see retained check.log')
  x['failure_cause']=(x['failure_cause'] or '')+'; artifact: '+detail
 rows.append(x)
audit_path=R/'evidence/continuation-grader-audit.json'
normalized={x['id']:x for x in json.loads(audit_path.read_text())} if audit_path.exists() else {}
for row in rows:
 row['raw_pass']=row['pass'];row['effective_pass']=normalized.get(row['id'],{}).get('effective_pass',row['pass'])
 if not row['pass'] and row['effective_pass']:
  row['failure_category']='benchmark setup'
  row['failure_cause']='Raw frozen trace grader cannot link stored-response tool results; unchanged grader passes after captured call-history expansion. Raw failure retained.'
 row['continuation_normalized']=row['id'] in normalized
ledgers={}
for provider in ['minimax','grok','openai']:
 p=R/('spend-'+provider+'.jsonl');v=[json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
 a=R/(provider+'-admissions.jsonl');adm=[json.loads(l) for l in a.read_text().splitlines()] if a.exists() else []
 finished={(x['run'],x['call']) for x in v}
 unresolved=[x for x in adm if (x['run'],x['call']) not in finished]
 ledgers[provider]={'admitted':len(adm),'completed_records':len(v),'recorded_usd':sum(x['cost_usd'] or 0 for x in v) if provider=='minimax' else None,'charged_usd':sum(x['budget_charge_usd'] for x in v)+sum(x.get('reserve',0) for x in unresolved) if provider=='minimax' else None,'missing_usage':sum(x['usage_missing'] for x in v),'interrupted_or_pending':len(unresolved)}
snap=R/'evidence/overlap-snapshots.jsonl';snaps=[json.loads(l) for l in snap.read_text().splitlines()] if snap.exists() else []
for row in rows:
 during=[s for s in snaps if row['started_at']-10<=s['time']<=row['finished_at']+10]
 row['other_job_overlap']=sorted(set(p['job']+':'+p['kind'] for s in during for p in s['processes']))
# Independent raw other-job provider intervals, read only. No tokens/headers collected.
intervals=[]
for job in ('light-ultra','light-port'):
 root=R.parent/job
 for p in root.glob('spend*.jsonl'):
  if p.is_symlink():continue
  for line in p.read_text().splitlines():
   try:
    x=json.loads(line);start=x.get('time');seconds=x.get('seconds')
    if isinstance(start,(float,int)) and isinstance(seconds,(float,int)):
     run=x.get('run','');origin='light-port' if run.startswith(('port/','port:')) else 'light-ultra' if run.startswith(('main/','main:')) else job
     intervals.append((origin,start,start+seconds))
   except (ValueError,KeyError):pass
for row in rows:
 row['other_job_provider_overlap']=sorted(set(job for job,a,b in intervals if a<row['finished_at'] and b>row['started_at']))
luna=R.parent/'light-ultra/spend-luna.jsonl'
luna_intervals=[]
if luna.exists():
 for line in luna.read_text().splitlines():
  x=json.loads(line)
  if isinstance(x.get('time'),(float,int)) and isinstance(x.get('seconds'),(float,int)):luna_intervals.append((x['time'],x['time']+x['seconds']))
for row in rows:
 row['main_luna_overlap']=any(a<row['finished_at'] and b>row['started_at'] for a,b in luna_intervals)
out={'at':time.time(),'runs':rows,'ledgers':ledgers}
(R/'evidence/metrics.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'cells':len(rows),'pass':sum(x['pass'] for x in rows),'ledgers':ledgers}))
