"""Sequential frozen cohorts with concise completion events and complete logs."""
import argparse, json, pathlib, re, subprocess
root=pathlib.Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--phase')
parser.add_argument('--build')
parser.add_argument('--catalog',choices=['0','1'],default='0')
args=parser.parse_args()
cohorts=[('candidate-window-subset','core-window','0'),
         ('candidate-catalog-fixed','core-window','1'),
         ('candidate-direct-subset','core-direct','0')]
if args.phase or args.build:
    if not re.fullmatch(r'candidate-[a-z0-9-]+',args.phase or '') or not re.fullmatch(r'core-[a-z0-9-]+',args.build or ''):
        raise SystemExit('Provide a valid phase and build together')
    cohorts=[(args.phase,args.build,args.catalog)]
for phase,build,catalog in cohorts:
    print('Start '+phase,flush=True)
    command=['bash',str(root/'bench/run-cohort.sh'),phase,build,
             '01-chunked-strict,04-count-by,06-key-rotation-map,12-partition-map','1','1',catalog,'harness-fast']
    with (root/'evidence'/f'{phase}-launch.log').open('x') as log:
        process=subprocess.Popen(command,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        for line in process.stdout:
            log.write(line);log.flush()
            try:value=json.loads(line)
            except ValueError:continue
            if 'id' in value and 'pass' in value:
                print(json.dumps({k:value.get(k) for k in ['id','pass','check_pass','wall_seconds','model_calls','input_tokens','output_tokens']}),flush=True)
            elif 'total_balance' in value:print(json.dumps(value),flush=True)
        code=process.wait()
        if code:raise SystemExit(f'{phase} exited {code}; inspect retained log')
    print('End '+phase,flush=True)
