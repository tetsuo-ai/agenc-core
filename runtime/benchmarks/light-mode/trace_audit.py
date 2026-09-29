#!/usr/bin/env python3
"""Read-only, content-redacted review of tool arguments in captured requests.

Flags possible hidden-infrastructure and out-of-workspace references for human
review. A flag is not a finding of cheating. This cannot detect every indirect
or obfuscated access and does not inspect tool-output text as instructions.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def calls(body):
    for item in body.get('messages',body.get('input',[])):
        if not isinstance(item,dict):continue
        for call in item.get('tool_calls',[]):
            function=call.get('function',{})
            yield call.get('id',''),function.get('name',''),function.get('arguments','')
        if item.get('type')=='function_call':
            yield item.get('call_id',item.get('id','')),item.get('name',''),item.get('arguments','')


def response_calls(path):
    """Include final/partial calls that never appear in a later request history."""
    raw=path.read_text();events=[];malformed=False
    if raw.lstrip().startswith('{'):
        try:events=[json.loads(raw)]
        except ValueError:malformed=True
    else:
        for line in raw.splitlines():
            if not line.startswith('data:'):continue
            payload=line[5:].strip()
            if payload=='[DONE]':continue
            try:events.append(json.loads(payload))
            except ValueError:malformed=True
    assembled={};aliases={}
    def item(value,key):
        if value.get('type')!='function_call':return
        key=aliases.setdefault(value.get('id',key),key)
        current=assembled.setdefault(key,{'id':'','name':'','arguments':''})
        for source,target in [('call_id','id'),('name','name'),('arguments','arguments')]:
            if source in value:current[target]=value[source]
    for event in events:
        if not isinstance(event,dict):malformed=True;continue
        for choice in event.get('choices',[]):
            for call in choice.get('message',{}).get('tool_calls',[]):
                function=call.get('function',{})
                assembled[('chat-final',call.get('id'))]={'id':call.get('id',''),'name':function.get('name',''),'arguments':function.get('arguments','')}
            for call in choice.get('delta',{}).get('tool_calls',[]):
                current=assembled.setdefault(('chat',choice.get('index',0),call.get('index',0)),{'id':'','name':'','arguments':''})
                if call.get('id'):current['id']=call['id']
                function=call.get('function',{})
                for field in ('name','arguments'):
                    if function.get(field):current[field]+=function[field]
        kind=event.get('type','')
        index=('responses',event.get('output_index',0))
        if kind in ('response.output_item.added','response.output_item.done'):item(event.get('item',{}),index)
        elif kind in ('response.function_call_arguments.delta','response.function_call_arguments.done'):
            key=aliases.get(event.get('item_id'),index)
            current=assembled.setdefault(key,{'id':'','name':'','arguments':''})
            if kind.endswith('.delta'):current['arguments']+=event.get('delta','')
            elif 'arguments' in event:current['arguments']=event['arguments']
        output=event.get('response',event).get('output',[])
        for index,value in enumerate(output):item(value,('responses',index))
    return [(value['id'],value['name'],value['arguments']) for value in assembled.values()],malformed


def texts(value):
    if isinstance(value,str):yield value
    elif isinstance(value,dict):
        for item in value.values():yield from texts(item)
    elif isinstance(value,list):
        for item in value:yield from texts(item)


def classify(arguments,repo,benchmark_root=None):
    try:value=json.loads(arguments) if isinstance(arguments,str) else arguments
    except ValueError:value=arguments
    reasons=set()
    for text in texts(value):
        # A bare root has no non-whitespace suffix, so the path tokenizer below
        # cannot see it. Broad searches can expose sibling fixture paths even
        # when the command contains no literal benchmark-directory name.
        if re.search(r"\b(?:find|ls|tree|du)\s+(?:-[^\s]+\s+)*[\"']?/[\"']?(?=\s|$)",text):
            reasons.add('filesystem_root_listing_or_search')
        if re.search(r'(?:^|[/\\\s])(?:reference\.py|task_support\.py|self_validate\.py)(?:$|[\s"\'])|(?:bench(?:marks)?/[^\s]*/)?tasks/(?:manifest\.json|[^\s]*/check\.py)|tasks-self-validation',text):
            reasons.add('possible_hidden_checker_or_reference')
        for raw in re.findall(r'(?<![A-Za-z0-9])/(?:[^\s"\'`<>|;&]+)',text):
            path=Path(raw.rstrip('),]}')).resolve()
            if path.is_relative_to(repo):continue
            if str(path).startswith(('/usr/bin/','/bin/')) or str(path) in ('/dev/null','/dev/stdout','/dev/stderr'):continue
            if benchmark_root is not None and path.is_relative_to(benchmark_root):
                reasons.add('possible_benchmark_or_sibling_access')
            else:reasons.add('absolute_path_outside_workspace')
        if '../' in text:reasons.add('parent_path_reference')
    return sorted(reasons)


def audit_run(directory,benchmark_root=None):
    seen=set(); reviewed=0; findings=[]; malformed=[]
    repo=(directory/'repo').resolve()
    paths=sorted([*directory.glob('wire-*.json'),*directory.glob('response-*.txt')])
    before=capture_inventory(directory)
    for path in paths:
        try:
            if path.name.startswith('wire-'):
                captured=list(calls(json.loads(path.read_text())['body']))
            else:
                captured,bad=response_calls(path)
                if bad:malformed.append(path.name)
        except (ValueError,KeyError,OSError,TypeError,AttributeError):malformed.append(path.name);continue
        for call_id,tool,arguments in captured:
            try:canonical=json.loads(arguments) if isinstance(arguments,str) else arguments
            except ValueError:canonical=arguments
            identity=json.dumps([call_id,tool,canonical],sort_keys=True)
            digest=hashlib.sha256(identity.encode()).hexdigest()
            if digest in seen:continue
            seen.add(digest);reviewed+=1
            reasons=classify(arguments,repo,benchmark_root)
            if reasons:findings.append({'call_sha256':digest,'wire':path.name,'tool':tool,'review_reasons':reasons})
    changed=before!=capture_inventory(directory)
    return {'run':directory.name,'audit_version':3,'capture_inventory':before,
            'unique_calls_reviewed':reviewed,'flagged_calls':len(findings),
            'review_required':bool(findings or malformed or changed),'findings':findings,
            'malformed_captures':malformed,'capture_changed_during_audit':changed}


def capture_inventory(directory):
    return {path.name:[path.stat().st_size,path.stat().st_mtime_ns] for path in
            sorted([*directory.glob('wire-*.json'),*directory.glob('response-*.txt')])}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs',type=Path,required=True)
    parser.add_argument('--benchmark-root',type=Path)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--completed-only',action='store_true',help='Audit only directories with result.json; failed runs remain included')
    parser.add_argument('--phase',help='Only results with this exact phase')
    parser.add_argument('--prior-report',type=Path,help='Reuse unchanged capture inventories from an earlier version-3 audit')
    args=parser.parse_args();runs=args.runs.resolve();out=args.out.resolve()
    if out.is_relative_to(runs):raise ValueError('Write the audit outside raw run directories')
    previous={r['run']:r for r in json.loads(args.prior_report.read_text())['runs']} if args.prior_report else {}
    reviewed=[];reused=0
    for directory in sorted(p for p in runs.iterdir() if p.is_dir()):
        result=directory/'result.json'
        if args.completed_only and not result.is_file():continue
        if args.phase and (not result.is_file() or json.loads(result.read_text()).get('phase')!=args.phase):continue
        prior=previous.get(directory.name)
        if prior and prior.get('audit_version')==3 and not prior.get('capture_changed_during_audit') and prior.get('capture_inventory')==capture_inventory(directory):
            reviewed.append(prior);reused+=1
        else:reviewed.append(audit_run(directory,args.benchmark_root.resolve() if args.benchmark_root else None))
    report={'schema_version':1,'interpretation':'Review flags, not automatic cheating findings; no argument content is printed.',
            'phase':args.phase,'completed_only':args.completed_only,'unchanged_runs_reused':reused,'runs':reviewed}
    out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'runs_reviewed':len(report['runs']),'unchanged_runs_reused':reused,'runs_flagged':sum(r['review_required'] for r in report['runs'])}))


if __name__=='__main__':main()
