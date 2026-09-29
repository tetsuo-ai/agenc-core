#!/usr/bin/env python3
"""Export allowlisted metrics and raw-artifact hashes, never request/response text."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from summarize import effective_pass

RUN_FIELDS=('id','phase','provider','task','agent','model','repeat','pass','check_pass','coding_pass',
    'exit_code','timeout','budget_stop','stop_reason','wall_seconds','model_calls','provider_errors','usage_complete',
    'input_tokens','cached_tokens','uncached_tokens','output_tokens','tool_calls','cost_usd','cost_basis','budget_charge_usd',
    'first_system_chars','first_schema_chars','agent_revision','prompt_sha256','harness_sha256','configuration_sha256')
CALL_FIELDS=('run','call','model','input_tokens','cached_tokens','uncached_tokens','output_tokens','tool_calls',
    'cost_usd','cost_basis','budget_charge_usd','original_budget_charge_usd','budget_charge_basis','time','seconds','usage_missing','rates')
KEY_PATTERN=re.compile(r'sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')


def safe_value(value):
    if value is None or isinstance(value,(bool,int,float)):return value
    if isinstance(value,list) and all(isinstance(v,(int,float)) and not isinstance(v,bool) for v in value):return value
    if isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,220}',value) and not KEY_PATTERN.search(value):return value
    raise ValueError('A metric field contains unexpected text; review before exporting')


def fields(record,names):
    return {name:safe_value(record[name]) for name in names if name in record}


def preserve_unpriced_cost(record,public):
    # Historical OAuth-runner ledgers used numeric zero as a placeholder.
    # Keep that reported value separately, never publish it as a priced charge.
    if record.get('cost_basis')=='subscription-unpriced' or record.get('model')=='gpt-6-luna':
        if record.get('cost_usd') is not None:public['reported_cost_usd']=safe_value(record['cost_usd'])
        public['cost_usd']=None
        public['cost_basis']='subscription-unpriced'


def export(runs,ledgers,phases,destination):
    runs=runs.resolve();destination=destination.resolve()
    if destination.exists() or destination.is_relative_to(runs):raise ValueError('Choose a new destination outside raw runs')
    watched={}
    def read(path):
        before=path.stat();data=path.read_bytes();stat=path.stat()
        stamp=(stat.st_size,stat.st_mtime_ns)
        if (before.st_size,before.st_mtime_ns)!=stamp or (path in watched and watched[path]!=stamp):
            raise RuntimeError('Evidence changed during export; wait for runs to stop')
        watched[path]=stamp
        return data
    directories=sorted(p for p in runs.iterdir() if p.is_dir())
    filenames={directory:sorted(p.name for p in directory.iterdir() if p.is_file()) for directory in directories}
    results=[];attempts=[];inventory=[]
    for directory in directories:
        identity=safe_value(directory.name)
        result_path=directory/'result.json'
        record=json.loads(read(result_path)) if result_path.exists() else None
        if record is not None:
            public=fields(record,RUN_FIELDS)
            preserve_unpriced_cost(record,public)
            # Historical timeout/pass contradictions remain visible, never rewritten.
            public['effective_pass']=effective_pass(record)
            public['selected']=record.get('phase') in phases
            attempts.append(public)
            if public['selected']:results.append(public)
        else:attempts.append({'id':identity,'status':'cancelled_before_launch' if (directory/'CANCELLED-BEFORE-LAUNCH.json').exists() else 'incomplete','selected':any(identity.startswith(phase+'-') for phase in phases)})
        for path in sorted(directory.iterdir()):
            if not path.is_file() or not (re.fullmatch(r'(?:wire|response|usage)-\d+\.(?:json|txt)',path.name) or path.name in ('result.json','agent.log','setup.log','check.log','daemon-stop.log','CANCELLED-BEFORE-LAUNCH.json')):continue
            data=read(path)
            inventory.append({'run':identity,'artifact':path.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    accounting=[]
    for ledger in ledgers:
        for line in read(ledger).decode().splitlines():
            if not line.strip():continue
            record=json.loads(line);public=fields(record,CALL_FIELDS)
            preserve_unpriced_cost(record,public)
            public['error_present']=bool(record.get('error'))
            status=(record.get('error') or {}).get('status')
            if isinstance(status,int):public['http_status']=status
            accounting.append(public)
    if directories!=sorted(p for p in runs.iterdir() if p.is_dir()):raise RuntimeError('Run inventory changed during export')
    if any(names!=sorted(p.name for p in directory.iterdir() if p.is_file()) for directory,names in filenames.items()):raise RuntimeError('Run artifacts changed during export')
    if any((p.stat().st_size,p.stat().st_mtime_ns)!=stamp for p,stamp in watched.items()):raise RuntimeError('Evidence changed during export; wait for runs to stop')
    output={'selected-results.json':{'schema_version':1,'selected_phases':phases,'runs':results},
            'all-attempts.json':{'schema_version':1,'attempts':attempts},
            'all-call-accounting.json':{'schema_version':1,'calls':accounting},
            'raw-artifact-sha256.json':{'schema_version':1,'artifacts':inventory}}
    serialized={name:json.dumps(value,indent=2,allow_nan=False)+'\n' for name,value in output.items()}
    if any(KEY_PATTERN.search(value) for value in serialized.values()):raise ValueError('Key-pattern scan rejected export')
    destination.mkdir(parents=True,exist_ok=False)
    for name,value in serialized.items():(destination/name).write_text(value)
    return {'selected_runs':len(results),'all_attempts':len(attempts),'accounted_calls':len(accounting),'hashed_artifacts':len(inventory)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs',type=Path,required=True)
    parser.add_argument('--ledger',type=Path,action='append',required=True)
    parser.add_argument('--phases',required=True)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    if sys.platform!='linux':parser.error('Run evidence export on Linux')
    phases=args.phases.split(',')
    for phase in phases:safe_value(phase)
    print(json.dumps(export(args.runs,args.ledger,phases,args.out)))


if __name__=='__main__':main()
