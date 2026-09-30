import json,pathlib,sys,collections,statistics,math,datetime
root=pathlib.Path(sys.argv[1]);groups=collections.defaultdict(list)
for p in (root/'runs').glob('*/result.json'):
 r=json.loads(p.read_text());r['model_calls']=max(r['model_calls'],len(list(p.parent.glob('wire-*.json'))));groups[(r['phase'],r['model'],r['agent'])].append(r)
charges=collections.defaultdict(float)
ledger=root/'spend-reconciled.jsonl'
for line in ledger.read_text().splitlines():
 item=json.loads(line);charges[item['run']]+=item.get('budget_charge_usd',item.get('cost_usd',0)) or 0
rows=[]
for key,rs in sorted(groups.items()):
 times=sorted(r['wall_seconds'] for r in rs);n=len(rs);complete=all(r.get('usage_complete') for r in rs)
 tokens=sum(r['input_tokens']+r['output_tokens'] for r in rs)
 rows.append(dict(zip(['phase','model','agent'],key))|{'runs':n,'effective':sum(r.get('pass') and r.get('check_pass') and r.get('exit_code')==0 and not r.get('timeout') and not r.get('budget_stop') for r in rs),'artifact':sum(r.get('check_pass',False) for r in rs),'median':statistics.median(times),'p90':times[math.ceil(n*.9)-1],'mean_tokens':tokens/n if complete else None,'observed_tokens':tokens,'mean_calls':sum(r['model_calls'] for r in rs)/n,'cost_usd':sum(r.get('cost_usd') or 0 for r in rs) if complete and key[1]!='gpt-6-luna' else None,'observed_cost_usd':sum(r.get('cost_usd') or 0 for r in rs),'conservative_charge_usd':sum(charges[r['id']] for r in rs),'incomplete_usage':sum(not r.get('usage_complete') for r in rs)})
print(json.dumps({'snapshot':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rows':rows},indent=2))
