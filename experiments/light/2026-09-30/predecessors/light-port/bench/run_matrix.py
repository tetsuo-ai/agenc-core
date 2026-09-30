"""Declare a complete comparison matrix before launching new paid cells."""
import argparse
import json
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--build', required=True)
parser.add_argument('--prefix', required=True)
parser.add_argument('--fresh-confirmation', action='store_true')
args = parser.parse_args()
if not re.fullmatch(r'core-[a-z0-9-]+', args.build) or not re.fullmatch(r'candidate-[a-z0-9-]+', args.prefix):
    raise SystemExit('Invalid declared build or cohort prefix')
root = Path(__file__).resolve().parent.parent
subset = ['01-chunked-strict', '04-count-by', '06-key-rotation-map', '12-partition-map']
manifest = json.loads((root/'bench/harness/tasks/manifest.json').read_text())
remaining = [task['id'] for task in manifest['tasks'] if task['id'] not in subset]
decomposition = json.loads((root/'evidence/decomposition.json').read_text())
retained = [row for row in decomposition['runs'] if row['cohort'] == 'port/'+args.prefix+'-subset']
expected = {(model, task, 1) for model in ['deepseek-flash', 'deepseek-v4-pro'] for task in subset}
if len(retained) != 8 or {(row['model'], row['task'], row['repeat']) for row in retained} != expected:
    raise SystemExit('The eight declared screening cells must all be retained before extension')
plan = {'build': args.build, 'catalog': 0, 'harness': 'harness-fast',
        'retained': [row['id'] for row in retained],
        'cohorts': [args.prefix+'-subset', args.prefix+'-new', args.prefix+'-repeat2'],
        'new_cells': 40, 'total_cells': 48, 'rerun_failed_cells': False}
schedule = [(args.prefix+'-new', remaining, '2', '1'),
            (args.prefix+'-repeat2', subset, '1', '2')]
if args.fresh_confirmation:
    phase = args.prefix+'-confirmation'
    schedule = [(phase, [task['id'] for task in manifest['tasks']], '2', '1')]
    plan.update(cohorts=[phase], new_cells=48, screening_reused=False,
                note='All screening outcomes remain separate. This is one predeclared complete confirmation matrix; no selective retries.')
with (root/'evidence/matrix-plan.json').open('x') as output:
    json.dump(plan, output, indent=2)
    output.write('\n')
for phase, tasks, repeats, start in schedule:
    print('Start '+phase, flush=True)
    command = ['bash', str(root/'bench/run-cohort.sh'), phase, args.build,
               ','.join(tasks), repeats, start, '0', 'harness-fast']
    with (root/'evidence'/f'{phase}-launch.log').open('x') as log:
        process = subprocess.Popen(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in process.stdout:
            log.write(line)
            log.flush()
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if 'id' in value and 'pass' in value:
                print(json.dumps({key: value.get(key) for key in ['id', 'pass', 'check_pass', 'wall_seconds', 'model_calls', 'input_tokens', 'output_tokens']}), flush=True)
            elif 'total_balance' in value:
                print(json.dumps(value), flush=True)
        code = process.wait()
        if code:
            raise SystemExit(f'{phase} exited {code}; retained logs and partial cells require review')
    print('End '+phase, flush=True)
