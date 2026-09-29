#!/usr/bin/env python3
"""Summarize payload-free runtime spans. Nested spans must not be added."""
import argparse, collections, json, pathlib, statistics

def union_ms(intervals):
    total=0; cursor=float('-inf')
    for start,end in sorted(intervals):
        total+=max(0,end-max(cursor,start));cursor=max(cursor,end)
    return total

def post_tool_attribution(intervals, spans):
    # Exclusive wall-time attribution. Inner durability operations take
    # precedence over their enclosing receipt/admission/persistence spans.
    def category(name):
        if name=='persistence.fsync':return (0,'fsync')
        if name.startswith('persistence.sqlite_'):return (1,'sqlite')
        if name=='projection.thread_index':return (2,'derived_index')
        if name.startswith('receipts.'):return (3,'receipts')
        if name.startswith('prompt.'):return (4,'prompt_assembly')
        if name.startswith('persistence.'):return (5,'persistence_other')
        if name.startswith('admission.'):return (6,'admission')
        return None
    totals=collections.defaultdict(float)
    for begin,end in intervals:
        active=[];points={begin,end}
        for span in spans:
            kind=category(span['name'])
            a=max(begin,span['start_ms']);b=min(end,span['start_ms']+span['duration_ms'])
            if kind is not None and a<b:
                active.append((a,b,kind));points.update((a,b))
        points=sorted(points)
        for a,b in zip(points,points[1:]):
            kinds=[kind for start,finish,kind in active if start<=a and finish>=b]
            totals[min(kinds)[1] if kinds else 'other']+=b-a
    return dict(totals)

def summarize(root, label):
    runs=[]
    for f in sorted(root.glob(label+'-*/result.json')):
        result=json.loads(f.read_text());spans=[]
        for trace in f.parent.glob('timing.*.jsonl'):
            spans.extend(json.loads(line) for line in trace.read_text().splitlines())
        if 'start_ms' in result:
            spans=[s for s in spans if result['start_ms'] <= s['start_ms'] < result['end_ms']]
        by=collections.defaultdict(list)
        for span in spans:
            by[span['name']].append(span)
            if span['name']=='tool.invoke':by['tool.by_name.'+span['tool']].append(span)
        models=sorted(by['model.request'],key=lambda x:x['start_ms'])
        wire=result.get('request_boundaries',[])
        boundary_source='provider_api'
        if wire and all('response_end_ms' in event for event in wire):
            models=[{'start_ms':e['request_ms'],'duration_ms':e['response_end_ms']-e['request_ms']} for e in wire]
            boundary_source='scripted_server_wire'
        tools=by['tool.invoke']
        gaps=[];pre=[];post=[];between=[];post_intervals=[]
        for before,after in zip(models,models[1:]):
            begin=before['start_ms']+before['duration_ms'];end=after['start_ms']
            interval=[t for t in tools if t['start_ms']<end and t['start_ms']+t['duration_ms']>begin]
            if interval:
                pre.append(max(0,min(t['start_ms'] for t in interval)-begin))
                post_start=min(end,max(begin,max(t['start_ms']+t['duration_ms'] for t in interval)))
                post.append(end-post_start);post_intervals.append((post_start,end))
                busy=union_ms((max(begin,t['start_ms']),min(end,t['start_ms']+t['duration_ms'])) for t in interval)
                gap=max(0,end-begin-busy)
                gaps.append(gap);between.append(max(0,gap-pre[-1]-post[-1]))
            else:
                gaps.append(max(0,end-begin))
        totals={key:sum(s['duration_ms'] for s in value) for key,value in by.items()}
        union=union_ms((s['start_ms'],s['start_ms']+s['duration_ms']) for s in tools)
        totals['runtime_outside_tools']=result['wall_ms']-union
        totals['between_tools']=sum(between)
        totals.update({'post_tool.'+key:value for key,value in post_tool_attribution(post_intervals,spans).items()})
        totals['post_tool.fsync_count']=sum(s.get('count',0) for s in spans if any(a<=s['start_ms']<b for a,b in post_intervals))
        totals['post_tool.written_bytes']=sum(s.get('bytes',0) for s in spans if s['name']=='persistence.write' and any(a<=s['start_ms']<b for a,b in post_intervals))
        totals['first_request_assembly']=by['prompt.assembly'][0]['duration_ms'] if by['prompt.assembly'] else 0
        totals['boundary.overhead']=sum(gaps);totals['response_to_tool']=sum(pre);totals['tool_to_request']=sum(post)
        totals['fsync_count']=sum(s.get('count',0) for s in spans);totals['written_bytes']=sum(s.get('bytes',0) for s in spans if s['name']=='persistence.write')
        totals['native_fsync_count']=sum(s['name'] in ('native.fsync','native.fdatasync') for s in spans)
        totals['native_written_bytes']=sum(s.get('bytes',0) for s in spans if s['name'].startswith('native.'))
        runs.append({**result,'totals':totals,'boundary_source':boundary_source,'boundary_gaps_ms':gaps})
    groups={}
    for mode in sorted(set(r['mode'] for r in runs)):
        selected=[r for r in runs if r['mode']==mode];allgaps=[g for r in selected for g in r['boundary_gaps_ms']]
        names=sorted(set(k for r in selected for k in r['totals']))
        groups[mode]={'n':len(selected),'wall_ms':statistics.mean(r['wall_ms'] for r in selected),'daemon_stop_ms':statistics.mean(r['daemon_stop_ms'] for r in selected),'calls':sum(r['calls'] for r in selected),'exit_codes':[r['exit_code'] for r in selected], 'boundary_mean_ms':statistics.mean(allgaps) if allgaps else None, 'boundary_p95_ms':sorted(allgaps)[int((len(allgaps)-1)*.95)] if allgaps else None,'spans_per_task':{k:statistics.mean(r['totals'].get(k,0) for r in selected) for k in names}}
    return {'groups':groups,'runs':runs}
if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('root',type=pathlib.Path);ap.add_argument('label');a=ap.parse_args();print(json.dumps(summarize(a.root,a.label),indent=2))
