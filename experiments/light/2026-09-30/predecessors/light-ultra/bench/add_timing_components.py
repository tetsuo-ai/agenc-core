from pathlib import Path
import json,datetime,collections
r=Path.home()/'claude-agenc-work/light-ultra';p=r/'analysis/decomposition.json';d=json.loads(p.read_text())
for row in d['runs']:
 if row['agent']=='pi':continue
 folder=r/'runs'/row['id']; intervals=[];elapsed=[]
 for trace in folder.rglob('rollout-*.jsonl'):
  events=[]
  for line in trace.read_text().splitlines():
   try:
    x=json.loads(line)
    if x.get('type')=='event_msg':events.append(x['payload']['msg'])
   except (ValueError,KeyError):pass
  end={}
  for x in events:
   payload=x.get('payload',{})
   if x.get('type')=='effect_result':end[payload.get('callId')]=payload.get('recordedAt')
   if x.get('type')=='tool_call_completed':
    duration=payload.get('durationMs')
    if isinstance(duration,(int,float)):
     elapsed.append(duration/1000)
     at=end.get(payload.get('callId'))
     if at:
      e=datetime.datetime.fromisoformat(at.replace('Z','+00:00')).timestamp();intervals.append((e-duration/1000,e))
 merged=[]
 for lo,hi in sorted(intervals):
  if merged and lo<=merged[-1][1]:merged[-1]=(merged[-1][0],max(hi,merged[-1][1]))
  else:merged.append((lo,hi))
 row['tool_duration_sum_s']=sum(elapsed) if elapsed else None
 # Effect-result is shortly before tool_call_completed: retain this as a diagnostic estimate.
 row['tool_interval_estimate_s']=sum(hi-lo for lo,hi in merged) if intervals else None
 row['overhead_estimate_s']=row['tool_plus_overhead_s']-row['tool_interval_estimate_s'] if intervals else None
 if intervals:row['tool_timing_method']='Union of measured tool duration intervals anchored to effect-result timestamps; event serialization shifts endpoints slightly. Diagnostic estimate, not exact critical-path measurement.'
p.write_text(json.dumps(d,indent=2)+'\n')
print('annotated',sum(r.get('tool_duration_sum_s') is not None for r in d['runs']))
