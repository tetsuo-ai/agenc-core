"""Analysis-only continuation expansion; raw model traffic and frozen grader unchanged."""
import pathlib,json,hashlib
from trace_checks import planning_evidence
R=pathlib.Path('/home/paul/claude-agenc-work/light-models')
def response_calls(path):
    result={}
    if not path.exists():return result
    for line in path.read_text().splitlines():
        if not line.startswith('data: '):continue
        try:e=json.loads(line[6:])
        except ValueError:continue
        candidates=[e.get('item',{})]+e.get('response',{}).get('output',[])
        for item in candidates:
            if item.get('type')=='function_call' and item.get('call_id') and item.get('name'):
                result[item['call_id']]={k:item[k] for k in ('type','call_id','name','arguments') if k in item}
    return result
out=[]
for folder in sorted((R/'runs').glob('*')):
    if not (folder/'result.json').exists():continue
    result=json.loads((folder/'result.json').read_text())
    if not result.get('deferred_evidence',{}).get('required'):continue
    target=R/'derived'/folder.name;target.mkdir(parents=True,exist_ok=True)
    known={};sources={};inserted=[]
    for wire in sorted(folder.glob('wire-*.json')):
        n=int(wire.stem.split('-')[1])
        if n>1:
            response=folder/f'response-{n-1:03}.txt'
            for cid,call in response_calls(response).items():known[cid]=call;sources[cid]=response.name
        raw=json.loads(wire.read_text());body=raw['body'];items=body.get('input')
        if isinstance(items,list):
            present={item.get('call_id') for item in items if item.get('type')=='function_call'}
            expanded=[]
            for item in items:
                cid=item.get('call_id')
                if item.get('type')=='function_call_output' and cid not in present and cid in known:
                    expanded.append(known[cid]);present.add(cid)
                    inserted.append({'wire':wire.name,'call_id':cid,'function':known[cid]['name'],'source_response':sources[cid]})
                expanded.append(item)
            body['input']=expanded
        raw['analysis_only']=True;raw['raw_wire_sha256']=hashlib.sha256(wire.read_bytes()).hexdigest()
        (target/wire.name).write_text(json.dumps(raw)+'\n')
    # Exactly the frozen grader. Both Light arm labels map to its canonical light category.
    graded=planning_evidence(target,'light')
    row={'id':folder.name,'raw_pass':result['pass'],'raw_deferred_evidence':result['deferred_evidence'],'normalized_deferred_evidence':graded,'insertions':inserted,'source_result_sha256':hashlib.sha256((folder/'result.json').read_bytes()).hexdigest(),'effective_pass':bool(result.get('coding_pass',False) and graded['pass'])}
    (target/'audit.json').write_text(json.dumps(row,indent=2)+'\n');out.append(row)
(R/'evidence/continuation-grader-audit.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps([{'id':x['id'],'raw_pass':x['raw_pass'],'effective_pass':x['effective_pass'],'insertions':len(x['insertions'])} for x in out]))
