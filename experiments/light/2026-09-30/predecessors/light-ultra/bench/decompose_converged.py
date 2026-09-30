"""Read-only decomposition of saved wire/usage records, without package prose."""
import argparse, collections, datetime, functools, hashlib, json, statistics, math, os
from pathlib import Path
from tokenizers import Tokenizer
p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('--out',type=Path,required=True);p.add_argument('--tokenizer',type=Path);p.add_argument('--phases',default='');a=p.parse_args()
tokenizer_path=a.tokenizer or a.root/'tokenizer/deepseek_v4_tokenizer/tokenizer.json'
a.out.parent.mkdir(parents=True,exist_ok=True)
tok=Tokenizer.from_file(str(tokenizer_path))
os.environ.setdefault('TIKTOKEN_CACHE_DIR',str(a.root/'tokenizer/tiktoken-cache'))
import tiktoken
reference=tiktoken.get_encoding('o200k_base')
codec='deepseek'
@functools.lru_cache(maxsize=16000)
def token_count(kind,s):
 return len(tok.encode(s,add_special_tokens=False).ids) if kind=='deepseek' else len(reference.encode(s,disallowed_special=()))
def count(s): return token_count(codec,s)
def wire_messages(body):
 if 'messages' in body:return body['messages']
 messages=[]
 if body.get('instructions'):messages.append({'role':'system','content':body['instructions']})
 for item in body.get('input',[]):
  kind=item.get('type')
  if kind=='function_call':messages.append({'role':'assistant','content':'','tool_calls':[{'id':item.get('call_id'),'function':{'name':item.get('name'),'arguments':item.get('arguments','')}}]})
  elif kind=='function_call_output':messages.append({'role':'tool','tool_call_id':item.get('call_id'),'content':item.get('output','')})
  elif kind=='reasoning':
   # Encrypted bytes are transport state, not plaintext tokenizer input.
   messages.append({'role':'assistant','content':'','reasoning_content':'\n'.join(x.get('text','') for x in item.get('summary',[])),'opaque_reasoning_bytes':len(item.get('encrypted_content','').encode())})
  elif item.get('role'):messages.append(item)
 return messages
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
 if a.phases and r['phase'] not in a.phases.split(','): continue
 if not (a.phases or r['phase'] in ('candidate-c1','candidate-c2','candidate-c3','candidate-api-p','candidate-api-b','candidate-api-c','candidate-eq') or r['phase']=='baseline' and r['agent']=='pi'): continue
 if r['model'] not in ('deepseek-flash','deepseek-v4-pro','gpt-6-luna'): continue
 codec='openai-reference' if r['model']=='gpt-6-luna' else 'deepseek'
 us=sorted([json.loads(p.read_text()) for p in path.parent.glob('usage-*.json')],key=lambda x:x['call'])
 N=max(len(us),len(list(path.parent.glob('wire-*.json'))))
 if not us:
  if r.get('model_calls') != 0 or r.get('input_tokens') != 0:
   raise ValueError('Missing call records without a confirmed zero-call result: '+r['id'])
  rows.append({'id':r['id'],'phase':r['phase'],'agent':r['agent'],'model':r['model'],'task':r['task'],'repeat':r['repeat'],'effective':False,
   'N':0,'P_raw':None,'P_system_raw':None,'P_schema_raw':None,'NP_raw':0,'history_residual':0,'schema_growth_raw':0,
   'input':0,'output':0,'reasoning':0,'visible_output':0,'total':0,'largest_results':[],'largest_replay':[],'poll_results':0,
   'ttft_s':None,'generation_s':None,'model_s':0,'tool_s':None,'overhead_s':None,'tool_plus_overhead_s':r['wall_seconds'],
   'wall_s':r['wall_seconds'],'cost_usd':r.get('cost_usd'),'zero_call_infrastructure_failure':True})
  continue
 first=json.loads((path.parent/'wire-001.json').read_text())['body']
 system='\n\n'.join((m.get('content','') if isinstance(m.get('content',''),str) else compact(m.get('content',''))) for m in wire_messages(first) if m['role'] in ('system','developer'))
 schemas=compact(first.get('tools',[]));P=count(system)+count(schemas)
 schema_sum=0;tool_results={};polls=0;tool_names={};history_components=collections.Counter();history_messages={}
 for w in sorted(path.parent.glob('wire-*.json')):
  i=int(w.stem.split('-')[-1]);b=json.loads(w.read_text())['body']
  schema_sum+=count(compact(b.get('tools',[])))-count(schemas)
  for j,m in enumerate(wire_messages(b)):
   for t in m.get('tool_calls') or []:tool_names[t['id']]=t['function']['name']
   role=m.get('role')
   if role not in ('system','developer'):
    history_components['opaque_reasoning_replay_bytes']+=m.get('opaque_reasoning_bytes',0)
    serialized=compact({k:v for k,v in m.items() if k!='opaque_reasoning_bytes'});key=hashlib.sha256(serialized.encode()).hexdigest()
    content=m.get('content','');content=content if isinstance(content,str) else compact(content)
    reason=m.get('reasoning_content') or ''
    if not isinstance(reason,str):reason=compact(reason)
    argument_tokens=sum(count(t.get('function',{}).get('arguments') or '') for t in m.get('tool_calls') or [])
    history_components['assistant_reasoning' if role=='assistant' else 'other_reasoning']+=count(reason)
    history_components[{'tool':'tool_results','assistant':'assistant_text','user':'user_text'}.get(role,'other_content')]+=count(content)
    history_components['tool_arguments']+=argument_tokens
    history_components['serialized_messages']+=count(serialized)
    if key not in history_messages:
     history_messages[key]={'role':role,'raw_tokens':count(serialized),'reasoning_raw_tokens':count(reason),'argument_raw_tokens':argument_tokens,'first_input_call':i,'message_position':j,'replayed_raw_tokens':0}
    history_messages[key]['replayed_raw_tokens']+=count(serialized)
   if m['role']!='tool':continue
   key=m.get('tool_call_id') or str(j)
   if key in tool_results:continue
   content=m.get('content','');s=content if isinstance(content,str) else compact(content)
   tool_results[key]={'raw_tokens':count(s),'chars':len(s),'first_input_call':i,'message_position':j,'tool':tool_names.get(key),'later_replay_estimate':count(s)*(N-i+1)}
 polls=sum(x['tool'] in ('write_stdin','system.write_stdin') for x in tool_results.values())
 reasoning=[u.get('usage',{}).get('output_tokens_details' if codec=='openai-reference' else 'completion_tokens_details',{}).get('reasoning_tokens') for u in us]
 complete=bool(r.get('usage_complete')) and len(us)==N and all(not u.get('usage_missing') for u in us)
 inp=sum(u['input_tokens'] for u in us) if complete else None
 out=sum(u['output_tokens'] for u in us) if complete else None
 reason=sum(reasoning) if all(x is not None for x in reasoning) else None
 timing=[dict(u['timing'], upstream_start_at=u['timing'].get('upstream_start_at',u['timing'].get('request_start_at'))) for u in us if all(u.get('timing',{}).get(k) is not None for k in ('first_token_at','last_token_at')) and u['timing'].get('upstream_start_at',u['timing'].get('request_start_at')) is not None]
 ttft=sum(t['first_token_at']-t['upstream_start_at'] for t in timing) if len(timing)==N else None
 gen=sum(t['last_token_at']-t['first_token_at'] for t in timing) if len(timing)==N else None
 model_s=sum(u['seconds'] for u in us)
 rows.append({'id':r['id'],'phase':r['phase'],'agent':r['agent'],'model':r['model'],'task':r['task'],'repeat':r['repeat'],'effective':bool(r['pass'] and r['check_pass'] and r['exit_code']==0 and not r.get('timeout') and not r.get('budget_stop')),'N':N,'prefix_tokenizer':'o200k_base reference estimate; Luna tokenizer unavailable' if codec=='openai-reference' else 'official DeepSeek V4 raw tokenizer','P_raw':P,'P_system_raw':count(system),'P_schema_raw':count(schemas),'NP_raw':N*P,'history_residual':inp-N*P if inp is not None else None,'schema_growth_raw':schema_sum,'input':inp,'output':out,'reasoning':reason,'visible_output':out-reason if out is not None and reason is not None else None,'total':inp+out if inp is not None else None,'largest_results':sorted(tool_results.values(),key=lambda x:x['raw_tokens'],reverse=True)[:3],'history_components_raw':dict(history_components),'largest_messages':sorted(history_messages.values(),key=lambda x:x['raw_tokens'],reverse=True)[:3],'largest_message_replay':sorted(history_messages.values(),key=lambda x:x['replayed_raw_tokens'],reverse=True)[:3],'largest_replay':sorted(tool_results.values(),key=lambda x:x['later_replay_estimate'],reverse=True)[:3],'poll_results':polls,'ttft_s':ttft,'generation_s':gen,'proxy_timing_complete':len(us)==N,'model_s':model_s if len(us)==N else None,'tool_s':None,'overhead_s':None,'tool_plus_overhead_s':r['wall_seconds']-model_s if len(us)==N else None,'wall_s':r['wall_seconds'],'cost_usd':r.get('cost_usd')})
 if r['agent']!='pi':
  measured=tool_timing(path.parent);rows[-1].update(measured)
  rows[-1]['overhead_estimate_s']=rows[-1]['tool_plus_overhead_s']-measured['tool_interval_estimate_s'] if measured['tool_interval_estimate_s'] is not None and rows[-1]['tool_plus_overhead_s'] is not None else None
  rows[-1]['tool_timing_method']='Measured tool durations anchored to effect-result timestamps and unioned for overlaps. Endpoints precede tool completion serialization slightly; overhead is diagnostic, not an exact critical-path split.'
a.out.write_text(json.dumps({'method':'P is independently tokenized system text plus compact schema JSON. DeepSeek uses its official V4 tokenizer. Luna uses o200k_base as a REFERENCE ESTIMATE, not its unavailable exact tokenizer; Responses items are normalized for raw history diagnostics. Opaque encrypted reasoning is reported in bytes and excluded from plaintext tokenization. H* is provider input minus N*P: it includes conversation history, initial task, provider framing and schema growth. Thus NP+H*+O equals measured total exactly; raw P is not a provider-isolated prefix count. Schema growth is separately reported. Largest messages include all non-system roles and reasoning, alongside the separate tool-result ranking. Counts are raw tokenization at first appearance, 1-based request and 0-based message positions. Raw history-field replay counts diagnose contributions but exclude provider framing and are not substituted for billed H*. TTFT/generation are null when instrumentation was absent. Historical tool wall time and client overhead cannot be separated on both agents; their measured combined residual is retained. N counts captured attempted requests, including a request missing final usage. Model/tool-plus-overhead time is unavailable if a request timing is missing. No unknown metric is zero-filled.','tokenizer_sha256':hashlib.sha256(tokenizer_path.read_bytes()).hexdigest(),'runs':rows},indent=2)+'\n')
print(json.dumps({'runs':len(rows),'path':str(a.out)}))
