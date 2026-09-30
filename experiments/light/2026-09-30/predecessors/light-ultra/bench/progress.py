import collections,json,pathlib,time
root=pathlib.Path.home()/'claude-agenc-work/light-ultra'
rows=[json.loads(p.read_text()) for p in (root/'runs').glob('*/result.json')]
out={'updated_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'phases':{}}
for phase in sorted({r['phase'] for r in rows}):
 rs=[r for r in rows if r['phase']==phase]
 out['phases'][phase]={'runs':len(rs),'artifact_pass':sum(r.get('check_pass',False) for r in rs),'effective_pass':sum(r.get('pass',False) and not r.get('timeout',False) and not r.get('budget_stop',False) and r.get('exit_code')==0 for r in rs),'incomplete_usage':sum(not r.get('usage_complete',False) for r in rs),'cells':dict(collections.Counter(r['model']+'/'+r['agent'] for r in rs))}
ledger_path=root/('spend-reconciled.jsonl' if (root/'spend-reconciled.jsonl').exists() else 'spend.jsonl')
ledger=[json.loads(l) for l in ledger_path.read_text().splitlines()]
out['spend']={'provider_list_rate_usd':sum(r.get('cost_usd',0) for r in ledger),'conservative_charge_usd':sum(r.get('budget_charge_usd',r.get('cost_usd',0)) for r in ledger),'calls':len(ledger)}
out['spend']['ledger']=ledger_path.name
out['unreported']=[p.name for p in (root/'runs').iterdir() if not (p/'result.json').exists()]
print(json.dumps(out,indent=2))
