#!/usr/bin/env python3
"""Read synthetic profile artifacts and emit scalar/function metadata only."""
from collections import defaultdict
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
result = json.loads((root/'light-r1/result.json').read_text())
cli_pid = result['cli_pid']
request_pid = next(r['pid'] for r in result['records_before_cleanup'] if r['stage'] == 'request_received')
reports = []
for path in sorted(root.glob('light-r1/*.cpuprofile')):
    p = json.loads(path.read_text())
    pid = int(path.name.split('.')[-2])
    nodes = {n['id']: n for n in p['nodes']}
    weights = defaultdict(int)
    for node, duration in zip(p.get('samples', []), p.get('timeDeltas', [])):
        weights[node] += duration
    inclusive = dict(weights)
    def descend(node_id):
        value = weights[node_id] + sum(descend(c) for c in nodes[node_id].get('children', []))
        inclusive[node_id] = value
        return value
    descend(p['nodes'][0]['id'])
    def rows(table):
        return [{'function': nodes[k]['callFrame']['functionName'],
                 'url': nodes[k]['callFrame']['url'],
                 'line': nodes[k]['callFrame']['lineNumber']+1,
                 'ms': v/1000} for k, v in sorted(table.items(), key=lambda kv: -kv[1])[:25]]
    reports.append({'pid': pid, 'role': 'cli' if pid == cli_pid else 'daemon' if pid == request_pid else 'cleanup',
                    'profile_span_ms': (p['endTime']-p['startTime'])/1000,
                    'sample_count': len(p.get('samples', [])),
                    'top_self': rows(weights), 'top_inclusive': rows(inclusive)})
print(json.dumps(reports, indent=2))
