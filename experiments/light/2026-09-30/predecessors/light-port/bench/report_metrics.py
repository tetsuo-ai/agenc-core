"""Compare a declared union of retained cohorts with frozen comparators."""
import argparse
import json
import math
from pathlib import Path
import statistics

parser = argparse.ArgumentParser()
parser.add_argument('--input', type=Path, required=True)
parser.add_argument('--cohorts', nargs='+', required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--require-full', action='store_true')
parser.add_argument('--main-cohorts', nargs='+', default=['main-selected-9e7'])
parser.add_argument('--repair-zero-call-sockets', action='store_true')
parser.add_argument('--repair-validation', type=Path)
args = parser.parse_args()
data = json.loads(args.input.read_text())
selected = [row for row in data['runs'] if row['cohort'] in args.cohorts]
all_attempts = list(selected)
infrastructure = []
if args.repair_zero_call_sockets:
    repaired=[]
    groups={}
    for row in selected:groups.setdefault((row['model'],row['task'],row['repeat']),[]).append(row)
    eligible={('deepseek-flash','11-compression-marker'),('deepseek-v4-pro','11-compression-marker'),('deepseek-v4-pro','09-separator-payload')}
    for key, rows in groups.items():
        if len(rows)==1:
            repaired += rows
            continue
        zeros=[row for row in rows if row['N']==0 and row.get('infrastructure')=='unix_socket_path_limit']
        valid=[row for row in rows if row['N']>0]
        if len(rows)!=2 or len(zeros)!=1 or len(valid)!=1 or key[:2] not in eligible:
            raise SystemExit('A duplicate cell is not an authorized zero-call socket repair')
        infrastructure += zeros
        repaired += valid
    if args.repair_validation is None:
        raise SystemExit('Provide the retained repair validation record')
    approved=set(json.loads(args.repair_validation.read_text())['eligible_zero_call_failures'])
    if {row['id'] for row in infrastructure} != approved:
        raise SystemExit('Replacement cells must exactly match the validated zero-call eligibility record')
    selected=repaired
identities = [(row['model'], row['task'], row['repeat']) for row in selected]
if len(identities) != len(set(identities)):
    raise SystemExit('Declared candidate cohorts contain duplicate cells')
fields = ['request_seconds', 'proxy_arrival_to_upstream', 'N', 'NP', 'schema_delta', 'H', 'visible', 'reasoning', 'tokens', 'ttft',
          'generation', 'tools', 'overhead', 'tools_overhead', 'guard', 'runtime_overhead']

def aggregate(rows):
    walls = sorted(row['wall'] for row in rows if row['wall'] is not None)
    result = {'runs': len(rows), 'passed': sum(row['pass_'] for row in rows)}
    for field in fields:
        values = [row[field] for row in rows]
        result[field] = statistics.mean(values) if rows and all(value is not None for value in values) else None
    result['median'] = statistics.median(walls) if walls and len(walls) == len(rows) else None
    result['p90'] = walls[math.ceil(.9*len(walls))-1] if walls and len(walls) == len(rows) else None
    result['observed_cost'] = sum(row['cost'] for row in rows)
    return result

results = []
for model in ['deepseek-flash', 'deepseek-v4-pro']:
    candidate = [row for row in selected if row['model'] == model]
    tasks = {row['task'] for row in candidate}
    pi = [row for row in data['runs'] if row['cohort'] == 'baseline-pi' and row['model'] == model and row['task'] in tasks]
    main = [row for row in data['runs'] if row['cohort'] in args.main_cohorts and row['model'] == model and row['task'] in tasks]
    if args.require_full and (len(candidate) != 24 or len(tasks) != 12 or {row['repeat'] for row in candidate} != {1, 2}):
        raise SystemExit('Expected the complete two-repeat matrix per model')
    if args.require_full:
        for name, comparator in [('Pi', pi), ('main', main)]:
            cells = {(row['task'], row['repeat']) for row in comparator}
            if len(comparator) != 24 or len(cells) != 24:
                raise SystemExit(name+' comparator must contain all 24 distinct cells')
    pi_cells = {(row['task'], row['repeat']): row for row in pi}
    lost_cells = [row['id'] for row in candidate if not row['pass_'] and pi_cells.get((row['task'], row['repeat']), {}).get('pass_', False)]
    lost_tasks = sorted({row['task'] for row in candidate if not row['pass_'] and any(p['pass_'] and p['task'] == row['task'] for p in pi)})
    c, p, m = aggregate(candidate), aggregate(pi), aggregate(main)
    comparisons = {field: c[field] is not None and p[field] is not None and c[field] < p[field] for field in ['median', 'p90', 'tokens']}
    comparisons['completion'] = bool(candidate) and not lost_tasks and c['passed']/c['runs'] >= p['passed']/p['runs']
    results.append({'model': model, 'candidate': c, 'pi': p, 'main_best_full': m,
                    'startup_inclusive_attempts': aggregate([row for row in all_attempts if row['model']==model]),
                    'original_launch': aggregate([row for row in all_attempts if row['model']==model and row['cohort']=='port/candidate-local-confirmation']),
                    'delta_pi': {field: c[field]-p[field] if c[field] is not None and p[field] is not None else None for field in fields},
                    'lost_pi_cells': lost_cells, 'lost_pi_tasks': lost_tasks,
                    'gates': comparisons, 'meets_all': all(comparisons.values())})
report = {'cohorts': args.cohorts, 'main_cohorts': args.main_cohorts, 'full_matrix': args.require_full,
          'selected_ids': [row['id'] for row in selected], 'infrastructure_attempts': infrastructure,
          'method': 'Failures included; unknown usage stays null; nearest-rank p90. Comparator subsets retain both original repeats. All selected cells appear exactly once.',
          'models': results}
args.out.write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
