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
    for path in sorted(directory.glob('wire-*.json')):
        try:body=json.loads(path.read_text())['body']
        except (ValueError,KeyError,OSError):malformed.append(path.name);continue
        for call_id,tool,arguments in calls(body):
            identity=json.dumps([call_id,tool,arguments],sort_keys=True)
            digest=hashlib.sha256(identity.encode()).hexdigest()
            if digest in seen:continue
            seen.add(digest);reviewed+=1
            reasons=classify(arguments,repo,benchmark_root)
            if reasons:findings.append({'call_sha256':digest,'wire':path.name,'tool':tool,'review_reasons':reasons})
    return {'run':directory.name,'unique_calls_reviewed':reviewed,'flagged_calls':len(findings),
            'review_required':bool(findings or malformed),'findings':findings,'malformed_captures':malformed}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs',type=Path,required=True)
    parser.add_argument('--benchmark-root',type=Path)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();runs=args.runs.resolve();out=args.out.resolve()
    if out.is_relative_to(runs):raise ValueError('Write the audit outside raw run directories')
    report={'schema_version':1,'interpretation':'Review flags, not automatic cheating findings; no argument content is printed.',
            'runs':[audit_run(p,args.benchmark_root.resolve() if args.benchmark_root else None) for p in sorted(runs.iterdir()) if p.is_dir()]}
    out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'runs_reviewed':len(report['runs']),'runs_flagged':sum(r['review_required'] for r in report['runs'])}))


if __name__=='__main__':main()
