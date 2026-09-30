"""Summarize provider-attributed Luna prefix tokens without exposing content."""
import collections
import json
from pathlib import Path

root = Path.home() / 'claude-agenc-work/light-ultra'
rows = []
for result in sorted((root / 'runs').glob('*/result.json')):
    run = json.loads(result.read_text())
    if run['model'] != 'gpt-6-luna':
        continue
    wires = sorted(result.parent.glob('wire-*.json'))
    usage = [json.loads(p.read_text()) for p in sorted(result.parent.glob('usage-*.json'))]
    attributed = []
    replay_items = replay_bytes = 0
    for wire in wires:
        body = json.loads(wire.read_text())['body']
        for item in body.get('input', []):
            if item.get('type') == 'reasoning':
                replay_items += 1
                replay_bytes += len(item.get('encrypted_content', '').encode())
    for call in usage:
        fields = call.get('usage', {}).get('attribution', {}).get('request_fields', {})
        if all(isinstance(fields.get(k, {}).get('input_tokens'), int) for k in ('instructions', 'tools')):
            attributed.append({k: fields[k]['input_tokens'] for k in ('instructions', 'tools')})
    complete = run.get('usage_complete') and len(usage) == len(wires)
    first = attributed[0] if attributed else None
    fixed = sum(first.values()) if first else None
    inp = sum(u['input_tokens'] for u in usage) if complete else None
    out = sum(u['output_tokens'] for u in usage) if complete else None
    reasoning = sum(u.get('usage', {}).get('output_tokens_details', {}).get('reasoning_tokens', 0) for u in usage) if complete else None
    rows.append({
        'id': run['id'], 'phase': run['phase'], 'agent': run['agent'],
        'task': run['task'], 'repeat': run['repeat'], 'effective': run['pass'],
        'N': len(wires), 'P_provider': fixed,
        'first_system_provider_tokens': first['instructions'] if first else None,
        'first_schema_provider_tokens': first['tools'] if first else None,
        'NP_provider': len(wires) * fixed if fixed is not None else None,
        'history_provider_residual': inp - len(wires) * fixed if inp is not None and fixed is not None else None,
        'dynamic_prefix_tokens': sum(sum(a.values()) for a in attributed) if len(attributed) == len(wires) else None,
        'input_tokens': inp, 'output_tokens': out, 'reasoning_tokens': reasoning,
        'replayed_reasoning_items': replay_items, 'opaque_replay_bytes': replay_bytes,
        'wall_seconds': run['wall_seconds'], 'usage_complete': bool(complete),
    })
report = {'method': 'Provider usage attribution for instructions and tools supplies exact first-prefix tokens where available. N*P uses that first prefix; residual includes task, history and later schema growth. Opaque replay is bytes summed over requests, not plaintext tokens. Missing usage stays unknown.', 'runs': rows}
(root / 'analysis/luna-mechanisms.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'runs': len(rows), 'provider_prefix_rows': sum(r['P_provider'] is not None for r in rows)}))
