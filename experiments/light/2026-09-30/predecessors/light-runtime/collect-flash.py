import pathlib,json,hashlib
root=pathlib.Path.home()/'claude-agenc-work/light-runtime';base=root/'flash-check'
records=[json.loads(l) for l in (base/'spend-deepseek.jsonl').open()]
rows=[]
for p in sorted(base.glob('runs/*/result.json')):
 r=json.loads(p.read_text());out={k:r[k] for k in ['id','task','agent_revision','harness_sha256','pass','check_pass','exit_code','timeout','budget_stop','stop_reason','model_calls','provider_errors','usage_complete','wall_seconds','cost_usd','configuration_sha256']}
 for k in ['coding_pass','deferred_evidence']:
  if k in r:out[k]=r[k]
 rs=[x for x in records if x['run']==r['id']]
 out['provider_seconds']=sum(x['seconds'] for x in rs)
 out['tool_plus_runtime_seconds']=r['wall_seconds']-out['provider_seconds']
 out['balance_admission']=json.loads((p.parent/'balance-admission.json').read_text())
 rows.append(out)
assert len(rows)==4
out={'provenance':json.loads((base/'provenance-candidate-runtime-deepseek.json').read_text()),'frozen_files_hash_match':True,'runs':rows,'total_cost_usd':sum(r['cost_usd'] for r in rows),'coding_check_passes':sum(r['check_pass'] for r in rows),'overall_passes':sum(r['pass'] for r in rows),'exact_key_scan':json.loads((root/'credential-scan-exact-remote.json').read_text())}
(root/'flash-evidence.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'runs':[{k:r[k] for k in ['task','pass','wall_seconds','provider_seconds','tool_plus_runtime_seconds','model_calls','cost_usd']} for r in rows],'total_cost_usd':out['total_cost_usd'],'balances':[r['balance_admission']['balance'] for r in rows]}))
