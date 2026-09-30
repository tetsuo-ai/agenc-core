"""Paired task bootstrap; never treats repeated runs as independent tasks."""
import collections
import json
import random
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
rows = json.loads((ROOT / 'evidence/convergence-results.json').read_text())
groups = collections.defaultdict(list)
for row in rows:
    if row['model'].startswith('deepseek') and row['task'][:2] not in {'03', '07', '09', '12'}:
        continue
    groups[(row['model'], row['job'] + '/' + row['phase'] + '/' + row['agent'])].append(row)

# Supplement only previously missing API Pi identities; never mix proxy cells.
api_pi = [r for r in rows if r['model']=='gpt-6-luna' and r['agent']=='pi' and r['phase'] in {'candidate-api-p','candidate-api-b'}]
assert len({(r['task'],r['repeat']) for r in api_pi}) == len(api_pi)
groups[('gpt-6-luna','light-ultra/api-pi-combined/pi')] = api_pi

def value(row, field):
    if field in {'tokens', 'uncached_tokens', 'cached_share'} and not row['usage_complete']:
        return None
    if field == 'tokens':
        return row['input_tokens'] + row['output_tokens']
    if field == 'cached_share':
        return row['cached_tokens'] / row['input_tokens'] if row['input_tokens'] else None
    return row.get(field)

def compare(candidate, baseline):
    # Match exact task/repeat identities before averaging within each task.
    index = {(r['task'], r['repeat']): r for r in baseline}
    pairs = [(r, index[(r['task'], r['repeat'])]) for r in candidate
             if (r['task'], r['repeat']) in index]
    result = {'pairs': len(pairs), 'lost_completions': [a['id'] for a,b in pairs if b['pass'] and not a['pass']]}
    for field in ['tokens', 'uncached_tokens', 'cached_share', 'wall_seconds', 'model_calls']:
        deltas = collections.defaultdict(list)
        for a,b in pairs:
            av,bv = value(a, field),value(b, field)
            if av is not None and bv is not None:
                deltas[a['task']].append(av-bv)
        means = [statistics.mean(v) for v in deltas.values()]
        if not means:
            result[field] = None
            continue
        rng = random.Random(20260929)
        samples = sorted(statistics.mean(rng.choices(means, k=len(means))) for _ in range(10000))
        interval = [samples[249], samples[9749]]
        result[field] = {'delta': statistics.mean(means), 'ci95': interval, 'tasks': len(means),
                         'within_noise': interval[0] <= 0 <= interval[1]}
    return result

comparisons = []
for (model,label), candidate in sorted(groups.items()):
    if '/candidate-c' not in label and '/candidate-api-' not in label:
        continue
    bases = ['light-ultra/baseline/pi','light-port/candidate-eq/light'] if model.startswith('deepseek') else ['light-ultra/api-pi-combined/pi']
    if '/candidate-c3/' in label:
        bases.append('light-ultra/candidate-c2/light')
    for base in bases:
        if label != base and (model,base) in groups:
            comparisons.append({'model':model,'candidate':label,'baseline':base,**compare(candidate,groups[(model,base)])})

lines = ['Matched task/repeat pairs, clustered by task. Seeded 10,000-resample percentile 95% intervals. Negative deltas favor the candidate for tokens/time. Intervals crossing zero are within noise; four-task screens cannot establish broad equivalence. Missing-usage pairs excluded only from token estimates, never completion.', '',
         '| Model / candidate vs baseline | Pairs / lost | Raw tokens delta [95% CI] | Uncached delta [95% CI] | Wall seconds delta [95% CI] |',
         '| --- | ---: | ---: | ---: | ---: |']
for c in comparisons:
    cells=[]
    for field in ['tokens','uncached_tokens','wall_seconds']:
        m=c[field]
        cells.append('unknown' if m is None else f'{m["delta"]:,.1f} [{m["ci95"][0]:,.1f}, {m["ci95"][1]:,.1f}]' + (' noise' if m['within_noise'] else ''))
    lines.append(f'| {c["model"]} / {c["candidate"]} vs {c["baseline"]} | {c["pairs"]} / {len(c["lost_completions"])} | ' + ' | '.join(cells) + ' |')
lines += ['', '| Model / cohort | Complete usage / runs | Raw tokens/run | Uncached input/run | Cache hit share |', '| --- | ---: | ---: | ---: | ---: |']
for (model,label),rs in sorted(groups.items()):
    valid=[r for r in rs if r['usage_complete']]
    if not valid: continue
    total_in=sum(r['input_tokens'] for r in valid)
    lines.append(f'| {model} / {label} | {len(valid)} / {len(rs)} | {statistics.mean(value(r,"tokens") for r in valid):,.0f} | {statistics.mean(r["uncached_tokens"] for r in valid):,.0f} | {sum(r["cached_tokens"] for r in valid)/total_in:.1%} |')
(ROOT/'evidence/convergence-paired.json').write_text(json.dumps(comparisons,indent=2)+'\n')
(ROOT/'evidence/convergence-paired.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines))
