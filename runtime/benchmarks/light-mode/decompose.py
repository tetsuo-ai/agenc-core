"""Read-only decomposition of saved wire/usage records, without package prose."""
import argparse, collections, datetime, functools, hashlib, json, statistics, math
from pathlib import Path
from tokenizers import Tokenizer
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('--out',type=Path,required=True);p.add_argument('--tokenizer',type=Path);a=p.parse_args()
tokenizer_path=a.tokenizer or a.root/'tokenizer/deepseek_v4_tokenizer/tokenizer.json'
a.out.parent.mkdir(parents=True,exist_ok=True)
tok=Tokenizer.from_file(str(tokenizer_path))
@functools.lru_cache(maxsize=16000)
def count(s): return len(tok.encode(s,add_special_tokens=False).ids)
def compact(x): return json.dumps(x,ensure_ascii=False,separators=(',',':'))
def tool_timing(folder):
 durations=[];intervals=[]
 for trace in folder.rglob('rollout-*.jsonl'):
  end={}
  for line in trace.read_text().splitlines():
   try:
    outer=json.loads(line)
    if outer.get('type')!='event_msg':continue
    event=outer['payload']['msg'];payload=event.get('payload',{})
    if event.get('type')=='effect_result':end[payload.get('callId')]=payload.get('recordedAt')
    if event.get('type')=='tool_call_completed' and isinstance(payload.get('durationMs'),(int,float)):
     seconds=payload['durationMs']/1000;durations.append(seconds)
     stamp=end.get(payload.get('callId'))
     if stamp:
      hi=datetime.datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()
      intervals.append((hi-seconds,hi))
   except (ValueError,KeyError):continue
 merged=[]
 for lo,hi in sorted(intervals):
  if merged and lo<=merged[-1][1]:merged[-1]=(merged[-1][0],max(hi,merged[-1][1]))
  else:merged.append((lo,hi))
 return {'tool_duration_sum_s':sum(durations) if durations else None,
         'tool_interval_estimate_s':sum(hi-lo for lo,hi in merged) if intervals else None}

rows=[]
for path in sorted((a.root/'runs').glob('*/result.json')):
 r=json.loads(path.read_text())
 if r['model'] not in ('deepseek-flash','deepseek-v4-pro'): continue
 us=sorted([json.loads(p.read_text()) for p in path.parent.glob('usage-*.json')],key=lambda x:x['call'])
 if not us:continue
 first=json.loads((path.parent/'wire-001.json').read_text())['body']
 system='\n\n'.join(m.get('content','') for m in first['messages'] if m['role'] in ('system','developer'))
 schemas=compact(first.get('tools',[]));P=count(system)+count(schemas)
 schema_sum=0;tool_results={};polls=0;tool_names={}
 for w in sorted(path.parent.glob('wire-*.json')):
  i=int(w.stem.split('-')[-1]);b=json.loads(w.read_text())['body']
  schema_sum+=count(compact(b.get('tools',[])))-count(schemas)
  for j,m in enumerate(b['messages']):
   for t in m.get('tool_calls') or []:tool_names[t['id']]=t['function']['name']
   if m['role']!='tool':continue
   key=m.get('tool_call_id') or str(j)
   if key in tool_results:continue
   content=m.get('content','');s=content if isinstance(content,str) else compact(content)
   tool_results[key]={'raw_tokens':count(s),'chars':len(s),'first_input_call':i,'message_position':j,'tool':tool_names.get(key),'later_replay_estimate':count(s)*(len(us)-i+1)}
 polls=sum(x['tool'] in ('write_stdin','system.write_stdin') for x in tool_results.values())
 reasoning=[u.get('usage',{}).get('completion_tokens_details',{}).get('reasoning_tokens') for u in us]
 complete=all(not u.get('usage_missing') for u in us)
 inp=sum(u['input_tokens'] for u in us) if complete else None
 out=sum(u['output_tokens'] for u in us) if complete else None
 reason=sum(reasoning) if all(x is not None for x in reasoning) else None
 timing=[u['timing'] for u in us if u.get('timing',{}).get('first_token_at') is not None]
 ttft=sum(t['first_token_at']-t['upstream_start_at'] for t in timing) if len(timing)==len(us) else None
 gen=sum(t['last_token_at']-t['first_token_at'] for t in timing) if len(timing)==len(us) else None
 model_s=sum(u['seconds'] for u in us)
 rows.append({'id':r['id'],'phase':r['phase'],'agent':r['agent'],'model':r['model'],'task':r['task'],'repeat':r['repeat'],'effective':bool(r['pass'] and r['check_pass'] and r['exit_code']==0 and not r.get('timeout') and not r.get('budget_stop')),'N':len(us),'P_raw':P,'P_system_raw':count(system),'P_schema_raw':count(schemas),'NP_raw':len(us)*P,'history_residual':inp-len(us)*P if inp is not None else None,'schema_growth_raw':schema_sum,'input':inp,'output':out,'reasoning':reason,'visible_output':out-reason if out is not None and reason is not None else None,'total':inp+out if inp is not None else None,'largest_results':sorted(tool_results.values(),key=lambda x:x['raw_tokens'],reverse=True)[:3],'largest_replay':sorted(tool_results.values(),key=lambda x:x['later_replay_estimate'],reverse=True)[:3],'poll_results':polls,'ttft_s':ttft,'generation_s':gen,'model_s':model_s,'tool_s':None,'overhead_s':None,'tool_plus_overhead_s':r['wall_seconds']-model_s,'wall_s':r['wall_seconds'],'cost_usd':r.get('cost_usd')})
 if r['agent']!='pi':
  measured=tool_timing(path.parent);rows[-1].update(measured)
  rows[-1]['overhead_estimate_s']=rows[-1]['tool_plus_overhead_s']-measured['tool_interval_estimate_s'] if measured['tool_interval_estimate_s'] is not None else None
  rows[-1]['tool_timing_method']='Measured tool durations anchored to effect-result timestamps and unioned for overlaps. Endpoints precede tool completion serialization slightly; overhead is diagnostic, not an exact critical-path split.'
 a.out.write_text(json.dumps({'method':'P is independently tokenized exact system text plus compact schema JSON. H* is provider input minus N*P: it includes conversation history, initial task, provider framing and schema growth. Thus NP+H*+O equals measured total exactly; raw P is not a provider-isolated prefix count. Schema growth is separately reported. Largest results are raw tokenizer counts at first appearance, 1-based request and 0-based message positions. TTFT/generation are null when instrumentation was absent. Historical tool wall time and client overhead cannot be separated on both agents; their measured combined residual is retained. No unknown metric is zero-filled.','tokenizer_sha256':hashlib.sha256(tokenizer_path.read_bytes()).hexdigest(),'runs':rows},indent=2)+'\n')
print(json.dumps({'runs':len(rows),'path':str(a.out)}))
