"""Read-only historical/request timing and exact offline head token measurements."""
import argparse,collections,json,statistics,math,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('--tokenizer',type=Path);a=p.parse_args()
tok=None
if a.tokenizer:
 from tokenizers import Tokenizer
 tok=Tokenizer.from_file(str(a.tokenizer))
def p90(values):return sorted(values)[math.ceil(len(values)*.9)-1] if values else None
def stats(values):return {'mean':statistics.mean(values),'median':statistics.median(values),'p90':p90(values)} if values else None
def count(text):return {'utf8_bytes':len(text.encode()),'characters':len(text),'raw_text_tokens':len(tok.encode(text,add_special_tokens=False).ids) if tok else None}
rows=[]
for path in sorted((a.root/'runs').glob('*/result.json')):
 r=json.loads(path.read_text())
 if not (r['phase']=='baseline' and r['agent'] in ('pi','normal') or r['phase'] in ('candidate-batch-subset','candidate-selected-new','candidate-selected-repeat2') or r['phase'].startswith('candidate-parity')):continue
 calls=sorted([json.loads(p.read_text()) for p in path.parent.glob('usage-*.json')],key=lambda x:x['call'])
 if not calls:continue
 body=json.loads((path.parent/'wire-001.json').read_text())['body']
 gaps=[b['time']-a['time']-a['seconds'] for a,b in zip(calls,calls[1:])]
 timing=[c['timing'] for c in calls if c.get('timing',{}).get('first_token_at') is not None]
 ttft=[t['first_token_at']-t['upstream_start_at'] for t in timing]
 generation=[t['last_token_at']-t['first_token_at'] for t in timing]
 system='\n\n'.join(m.get('content','') for m in body['messages'] if m['role'] in ('system','developer'))
 schemas=json.dumps(body.get('tools',[]),ensure_ascii=False,separators=(',',':'))
 runtime_total=r['wall_seconds']-sum(c['seconds'] for c in calls)
 cohort='selected-9e7' if r['phase'] in ('candidate-batch-subset','candidate-selected-new','candidate-selected-repeat2') else r['phase']
 rows.append({'id':r['id'],'cohort':cohort,'model':r['model'],'agent':r['agent'],'task':r['task'],'repeat':r['repeat'],
 'effective':bool(r['pass'] and r['check_pass'] and r['exit_code']==0 and not r.get('timeout') and not r.get('budget_stop')),
 'wall_seconds':r['wall_seconds'],'tokens':r['input_tokens']+r['output_tokens'] if r['usage_complete'] else None,
 'cost_usd':r['cost_usd'] if r['usage_complete'] else None,'calls':len(calls),'request_seconds':[c['seconds'] for c in calls],
 'runtime_total_seconds':runtime_total,'inter_call_gaps':gaps,'ttft':ttft,'generation':generation,
 'system':count(system),'tool_schemas_compact_json':count(schemas),'tools':[t['function']['name'] for t in body['tools']],
 'provider_first_input_tokens':calls[0]['input_tokens']})
groups=[]
for key in sorted({(r['cohort'],r['model'],r['agent']) for r in rows}):
 rs=[r for r in rows if (r['cohort'],r['model'],r['agent'])==key];calls=sum(r['calls'] for r in rs)
 group=dict(zip(('cohort','model','agent'),key));group.update(runs=len(rs),effective=sum(r['effective'] for r in rs),wall=stats([r['wall_seconds'] for r in rs]),tokens_mean=statistics.mean(r['tokens'] for r in rs) if all(r['tokens'] is not None for r in rs) else None,calls_mean=calls/len(rs),cost_usd=sum(r['cost_usd'] for r in rs) if all(r['cost_usd'] is not None for r in rs) else None)
 for name in ('request_seconds','inter_call_gaps','ttft','generation'):group[name]=stats(sum([r[name] for r in rs],[]))
 group['runtime_seconds_per_call']=sum(r['runtime_total_seconds'] for r in rs)/calls
 groups.append(group)
print(json.dumps({'tokenizer_sha256':hashlib.sha256(a.tokenizer.read_bytes()).hexdigest() if a.tokenizer else None,'units':'Raw system/schema tokens use the official DeepSeek V4 tokenizer on exact text / compact JSON, without special tokens. Provider first-input tokens include server formatting. Historical TTFT and generation durations were not recorded and are unavailable. Runtime gaps include tools and all between-call work; startup/shutdown also enter wall minus model duration.','groups':groups,'runs':rows},indent=2))
