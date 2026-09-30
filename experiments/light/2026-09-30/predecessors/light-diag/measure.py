"""Read completed benchmark records; emit numeric metadata only. No execution/imports of harness."""
from pathlib import Path
import json, datetime, collections

def stamp(s):
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

def union(intervals):
    out=[]
    for a,b in sorted(intervals):
        if b<a: continue
        if out and a<=out[-1][1]: out[-1]=(out[-1][0],max(b,out[-1][1]))
        else: out.append((a,b))
    return sum(b-a for a,b in out)

root=Path.home()/'claude-agenc-work'
rows=[]
for job in ('light-ultra','light-port'):
 for result in sorted((root/job/'runs').glob('*/result.json')):
    r=json.loads(result.read_text()); phase=r['phase']; agent=r['agent']; model=r['model']
    if job=='light-ultra':
        chosen=(phase in ('candidate-round2-new','candidate-round2-repeat2','candidate-round2-confirm-screen') or (phase=='baseline' and agent=='pi') or phase=='candidate-luna-full-r1')
    else: chosen=phase in ('candidate-local-subset','candidate-local-confirmation')
    if not chosen:continue
    folder=result.parent
    us=[json.loads(p.read_text()) for p in sorted(folder.glob('usage-*.json'))]
    row={k:r.get(k) for k in ('id','phase','agent','model','task','repeat','agent_revision','pass','check_pass','wall_seconds','model_calls','timeout','input_tokens','output_tokens')}
    row['job']=job;row['model_s']=sum(u['seconds'] for u in us)
    row['residual_s']=r['wall_seconds']-row['model_s']
    row['span_s']=(us[-1]['time']+us[-1]['seconds']-us[0]['time']) if us else 0
    row['outside_span_s']=r['wall_seconds']-row['span_s']
    row['inter_request_s']=row['span_s']-row['model_s']
    row['proxy_serialize_s']=sum(u.get('timing',{}).get('upstream_start_at',u['time'])-u['time'] for u in us)
    row['guard_s']=sum(u['time']-u.get('timing',{}).get('request_received_at',u['time']) for u in us)
    row['stream_tail_s']=sum(u['time']+u['seconds']-u.get('timing',{}).get('last_token_at',u['time']+u['seconds']) for u in us if u.get('timing',{}).get('last_token_at') is not None)
    ends={};intents={};tools=[];admissions=[]; tracefiles=[]
    for p in (folder/'home/agenc').glob('projects/*/sessions/*/rollout-*.jsonl'):
        tracefiles.append(str(p.relative_to(root)))
        for n,line in enumerate(p.open(),1):
            try:x=json.loads(line)
            except ValueError:continue
            if x.get('type')!='event_msg':continue
            event=x['payload']['msg']; a=event.get('payload',{}); typ=event['type']
            if typ=='effect_intent':intents[a['callId']]=stamp(a['recordedAt'])
            if typ=='effect_result':ends[a['callId']]=stamp(a['recordedAt'])
            if typ=='execution_admission':admissions.append(a)
            if typ=='tool_call_completed':
                tool={'name':a['toolName'],'id':a['callId'],'line':n,'s':a['durationMs']/1000,'error':a.get('isError',False)}
                tool['end']=ends.get(a['callId']);tool['intent']=intents.get(a['callId'])
                tool['start']=tool['end']-tool['s'] if tool['end'] else None
                meta=a.get('metadata') or {};tool['process_s']=meta.get('durationMs',0)/1000
                if a['toolName']=='exec_command':
                    tool['truncated']=meta.get('truncated');tool['exit']=meta.get('exitCode')
                tools.append(tool)
    row['traces']=tracefiles;row['tool_s']=sum(t['s'] for t in tools)
    row['tool_union_est_s']=union([(t['start'],t['end']) for t in tools if t['end']])
    row['tool_by_type']={k:round(sum(t['s'] for t in tools if t['name']==k),6) for k in sorted(set(t['name'] for t in tools))}
    row['tool_counts']=dict(collections.Counter(t['name'] for t in tools))
    row['process_s']=sum(t['process_s'] for t in tools)
    row['tools']=tools
    row['receipt_window_s']=sum(t['end']-t['intent'] for t in tools if t['end'] and t['intent'])
    ad={}
    for a in admissions:
        ad.setdefault(a['stepId'],{})[a['event']]=stamp(a['timestamp'])
    row['admission_wait_s']=sum(x['allowed']-x['queued'] for x in ad.values() if 'allowed' in x and 'queued' in x)
    row['tool_admission_wait_s']=sum(x['allowed']-x['queued'] for k,x in ad.items() if k.startswith('tool:') and 'allowed' in x and 'queued' in x)
    pre=post=mid=0;gaptools=0
    for u,v in zip(us,us[1:]):
        lo=u['time']+u['seconds'];hi=v['time']
        ts=[t for t in tools if t['end'] and lo-0.1 <= t['end'] <= hi+0.1]
        if ts:
            first=min(t['start'] for t in ts);last=max(t['end'] for t in ts)
            pre+=first-lo;post+=hi-last
            busy=union([(t['start'],t['end']) for t in ts]);gaptools+=busy
            mid+=last-first-busy
        else:post+=hi-lo
    row['response_to_tool_est_s']=pre;row['tool_to_request_est_s']=post
    row['between_tools_est_s']=mid;row['gap_tool_union_est_s']=gaptools
    if agent=='pi':
        for k in ('tool_s','tool_union_est_s','process_s','receipt_window_s','admission_wait_s','tool_admission_wait_s','response_to_tool_est_s','tool_to_request_est_s','between_tools_est_s','gap_tool_union_est_s'):
            row[k]=None
    rows.append(row)
print(json.dumps({'method':'Read-only numeric extraction. Tool starts estimated as effect_result.recordedAt minus completed duration; use cautiously. Outside span combines startup and final shutdown. No raw trace content copied.','runs':rows},indent=2))
