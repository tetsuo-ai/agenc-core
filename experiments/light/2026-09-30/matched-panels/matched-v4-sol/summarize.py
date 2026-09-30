#!/usr/bin/env python3
"""Summarize matched phases from their result.json files (reads a local copy).
Usage: summarize.py RESULTS_DIR [AUDIT_JSON ...]
RESULTS_DIR holds <run-id>/result.json for one or more phases of ONE provider
and model. Every cell must share one configuration identity per phase and the
twelve manifest tasks; omissions are listed, never silently dropped.
Metrics: completion, calls, tokens, list-rate cost, wall time per agent and per
category, and a paired bootstrap that resamples whole tasks (all repeats of a
task together). An interval spanning zero is inconclusive, not equivalence.
AUDIT_JSON files (from audit_cells.py) mark cells whose settings, sandbox or
usage are not clean; their affected metrics become inconclusive.
"""
import collections, json, pathlib, random, statistics, sys

EXPECTED_TASKS = 12
root = pathlib.Path(sys.argv[1])
rows = []
regraded = []
for p in sorted(root.glob('*/result.json')):
    r = json.loads(p.read_text())
    # A regrade re-runs the unchanged hidden checker on the preserved final repository after a
    # harness packaging fix. It is applied explicitly and listed, never silently.
    for g in sorted(p.parent.glob('regrade-*.json')):
        fix = json.loads(g.read_text())
        r['check_pass'] = fix['check_pass']
        r['pass'] = fix['check_pass'] and r['exit_code'] == 0 and not r['timeout'] and not r.get('budget_stop')
        regraded.append(f"{r['task']} {r['agent']} r{r['repeat']}: {'pass' if r['pass'] else 'fail'} ({g.name})")
    rows.append(r)
flagged = {}
for audit in sys.argv[2:]:
    a = json.loads(pathlib.Path(audit).read_text())
    if len(a['distinct_settings']) != 1:
        print('WARNING: request settings differ across cells:', a['distinct_settings'])
    flagged.update(a['cells_with_refusals'])

models = {r['model'] for r in rows}
if len(models) != 1:
    sys.exit(f'Refusing to mix models: {models}')
configs = collections.defaultdict(set)
for r in rows:
    configs[r['phase']].add(r['configuration_sha256'])
for phase, ids in configs.items():
    if len(ids) != 1:
        sys.exit(f'Phase {phase} mixes configurations: {ids}')

by = {(r['task'], r['repeat'], r['agent']): r for r in rows}
keys = sorted({(r['task'], r['repeat']) for r in rows})
pairs = [(by[k + ('light',)], by[k + ('pi',)]) for k in keys if k + ('light',) in by and k + ('pi',) in by]
unpaired = [k for k in keys if not (k + ('light',) in by and k + ('pi',) in by)]
tasks = sorted({k[0] for k in keys})
print(f'model {models.pop()}  phases {sorted(configs)}  cells {len(rows)}  matched pairs {len(pairs)}  tasks {len(tasks)}')
if unpaired:
    print('UNPAIRED (excluded from comparisons):', unpaired)
if len(tasks) != EXPECTED_TASKS:
    print(f'INCOMPLETE: {len(tasks)} of {EXPECTED_TASKS} tasks present')
if flagged:
    print('AUDIT FLAGS:', json.dumps(flagged))
if regraded:
    print('REGRADED (harness fix, unchanged checker):', '; '.join(regraded))


def clean_usage(r):
    return r['usage_complete'] and r['id'] not in flagged


def clean_cost(r):
    return r['cost_usd'] is not None and clean_usage(r)


def p90(xs):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(0.9 * (len(xs) - 1)))]


print(f'\n{"task":24} {"rep":3} {"agent":5} {"pass":4} {"calls":>5} {"input":>8} {"cached":>8} {"out":>6} {"cost $":>9} {"wall s":>7}')
for light, pi in pairs:
    for r in (light, pi):
        cost = f'{r["cost_usd"]:.5f}' if clean_cost(r) else 'n/a'
        print(f'{r["task"]:24} {r["repeat"]:<3} {r["agent"]:5} {"Y" if r["pass"] else "N":4} {r["model_calls"]:>5} '
              f'{r["input_tokens"]:>8} {r["cached_tokens"]:>8} {r["output_tokens"]:>6} {cost:>9} {r["wall_seconds"]:>7.1f}')

print()
for agent, idx in (('light', 0), ('pi', 1)):
    cells = [p[idx] for p in pairs]
    walls = [c['wall_seconds'] for c in cells]
    cost = 'inconclusive (usage incomplete or flagged)' if not all(clean_cost(c) for c in cells) else f'${sum(c["cost_usd"] for c in cells):.5f}'
    print(f'{agent:5} pass {sum(c["pass"] for c in cells)}/{len(cells)}  calls {sum(c["model_calls"] for c in cells)}  '
          f'input {sum(c["input_tokens"] for c in cells)}  cached {sum(c["cached_tokens"] for c in cells)}  '
          f'uncached+output {sum(c["uncached_tokens"] + c["output_tokens"] for c in cells)}  cost {cost}  '
          f'median {statistics.median(walls):.1f}s  p90 {p90(walls):.1f}s')

print('\nby category (Light / Pi): pass, calls, median wall s')
cats = collections.defaultdict(list)
for light, pi in pairs:
    cats[light['category']].append((light, pi))
for cat, ps in sorted(cats.items()):
    print(f'  {cat:32} pass {sum(l["pass"] for l, _ in ps)}/{sum(p["pass"] for _, p in ps)} of {len(ps)}  '
          f'calls {sum(l["model_calls"] for l, _ in ps)}/{sum(p["model_calls"] for _, p in ps)}  '
          f'wall {statistics.median(l["wall_seconds"] for l, _ in ps):.1f}/{statistics.median(p["wall_seconds"] for _, p in ps):.1f}')

print()
print('Light failed where Pi passed:', [f'{l["task"]} r{l["repeat"]}' for l, p in pairs if p['pass'] and not l['pass']] or 'none')
print('Light passed where Pi failed:', [f'{l["task"]} r{l["repeat"]}' for l, p in pairs if l['pass'] and not p['pass']] or 'none')

clusters = collections.defaultdict(list)
for light, pi in pairs:
    clusters[light['task']].append((light, pi))


def cluster_boot(f, n=20000, seed=1):
    rng = random.Random(seed)
    names = sorted(clusters)
    means = []
    for _ in range(n):
        diffs = [f(l) - f(p) for name in (rng.choice(names) for _ in names) for l, p in clusters[name]]
        means.append(statistics.fmean(diffs))
    means.sort()
    return means[int(0.025 * n)], means[int(0.975 * n)]


if len(clusters) >= 2:
    print('\nLight minus Pi, mean per cell, 95% bootstrap over whole tasks:')
    for label, f, needs_usage in (('wall seconds', lambda r: r['wall_seconds'], False),
                                  ('model calls', lambda r: r['model_calls'], False),
                                  ('uncached+output tokens', lambda r: r['uncached_tokens'] + r['output_tokens'], True),
                                  ('cost usd', lambda r: r['cost_usd'], True)):
        clean = clean_cost if label == 'cost usd' else clean_usage
        if needs_usage and not all(clean(c) for pair in pairs for c in pair):
            print(f'  {label}: inconclusive (usage incomplete or flagged)')
            continue
        diffs = [f(l) - f(p) for l, p in pairs]
        lo, hi = cluster_boot(f)
        verdict = 'inconclusive' if lo <= 0 <= hi else ('Light lower' if hi < 0 else 'Light higher')
        print(f'  {label}: {statistics.fmean(diffs):+.5g}  [{lo:+.5g}, {hi:+.5g}]  {verdict}')
    reps = {r for _, r in keys}
    if len(reps) == 1:
        print('  (one repeat: initial diagnostic panel, not evidence of superiority)')
