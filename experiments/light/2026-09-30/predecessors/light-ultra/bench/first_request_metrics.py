"""Report exact observed first requests and billed input; never infer tokens from bytes."""
import argparse, collections, json, statistics
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('root', type=Path)
p.add_argument('--phases', default='candidate-batch-subset,candidate-selected-new,candidate-selected-repeat2')
a = p.parse_args()
phases = set(a.phases.split(','))
first = {}
for line in (a.root / 'spend-reconciled.jsonl').read_text().splitlines():
    call = json.loads(line)
    if call.get('call') == 1:
        first[call['run']] = call.get('input_tokens')

rows = []
for path in sorted((a.root / 'runs').glob('*/result.json')):
    r = json.loads(path.read_text())
    if not (r['phase'] in phases or r['phase'] == 'baseline' and r['agent'] in ('pi', 'normal')):
        continue
    wire = sorted(path.parent.glob('wire-*.json'))[0]
    body = json.loads(wire.read_text())['body']
    compact = lambda value: json.dumps(value, separators=(',', ':'), ensure_ascii=False)
    system = sum(len(m.get('content', '')) for m in body['messages'] if m['role'] in ('system', 'developer'))
    schema = len(compact(body['tools']))
    rows.append({k: r[k] for k in ('id', 'model', 'task', 'agent', 'repeat', 'agent_revision')} | {
        'system_chars': system, 'schema_json_chars': schema, 'head_chars': system + schema,
        'serialized_body_chars': len(compact(body)), 'serialized_body_utf8_bytes': len(compact(body).encode()),
        'provider_first_input_tokens': first.get(r['id']),
        'tools': [t['function']['name'] for t in body['tools']],
    })
comparisons = []
for light in (r for r in rows if r['agent'] == 'light'):
    pi = next(r for r in rows if r['agent'] == 'pi' and
              (r['model'], r['task'], r['repeat']) == (light['model'], light['task'], light['repeat']))
    comparisons.append({'run': light['id'], 'pi_run': pi['id'],
        'head_chars_lower': light['head_chars'] < pi['head_chars'],
        'first_input_tokens_lower': light['provider_first_input_tokens'] < pi['provider_first_input_tokens'],
        'token_delta': light['provider_first_input_tokens'] - pi['provider_first_input_tokens'],
        'head_char_delta': light['head_chars'] - pi['head_chars']})
groups = []
for model, agent in sorted({(r['model'], r['agent']) for r in rows}):
    rs = [r for r in rows if (r['model'], r['agent']) == (model, agent)]
    groups.append({'model': model, 'agent': agent, 'runs': len(rs),
        'means': {k: statistics.mean(r[k] for r in rs) for k in
                  ('system_chars', 'schema_json_chars', 'head_chars', 'serialized_body_chars', 'provider_first_input_tokens')},
        'tools': sorted({tuple(r['tools']) for r in rs})})
print(json.dumps({'candidate_phases': sorted(phases), 'units': 'Character counts are diagnostic; tokens are exact provider first-call usage.',
    'groups': groups, 'comparisons': comparisons, 'runs': rows}, indent=2))
